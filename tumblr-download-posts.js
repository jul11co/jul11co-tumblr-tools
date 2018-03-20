#!/usr/bin/env node

var async = require('async');
var path = require('path');
var chalk = require('chalk');
var moment = require('moment');

var spawn = require('child_process').spawn;

var NeDB = require('nedb');
var lockFile = require('lockfile');

var JsonStore = require('jul11co-jsonstore');
var JobQueue = require('jul11co-jobqueue');

var utils = require('jul11co-utils');
var downloader = require('jul11co-wdt').Downloader;

function printUsage() {
  console.log('Usage: tumblr-download-posts <data-dir> [OPTIONS]');
  console.log('       tumblr-download-posts <data-dir> --tag TAG [OPTIONS]');
  console.log('       tumblr-download-posts <data-dir> --reblog BLOG [OPTIONS]');
  console.log('       tumblr-download-posts <data-dir> --origin BLOG [OPTIONS]');
  console.log('');
  console.log('OPTIONS:');
  console.log('     --verbose                        : verbose');
  console.log('');
  console.log('     --favorites                      : download favorite posts (specified in tumblr-favorites.json)');
  console.log('     --favorites-file <FILE>          : path to tumblr-favorites.json');
  console.log('');
  console.log('     --exported-posts                 : download using posts from exported posts file (default: tumblr-posts-exported.json)');
  console.log('     --exported-posts-file <FILE>     : path to tumblr-posts-exported.json');
  console.log('');
  console.log('     --selected-posts-file <FILE>     : path to selected-posts.json');
  console.log('');
}

if (process.argv.indexOf('-h') >= 0 
  || process.argv.indexOf('--help') >= 0
  || process.argv.length < 3) {
  printUsage();
  process.exit();
}

// console.log(process.argv);

var options = {};
var argv = [];
for (var i = 2; i < process.argv.length; i++) {
  if (process.argv[i] == '--tag') {
    options.tag = process.argv[i+1];
    i++;
  } else if (process.argv[i] == '--reblog') {
    options.reblog = process.argv[i+1];
    i++;
  } else if (process.argv[i] == '--origin') {
    options.origin = process.argv[i+1];
    i++;
  } else if (process.argv[i] == '--favorites-file') {
    options.favorites_file = process.argv[i+1];
    i++;
  } else if (process.argv[i] == '--exported-posts-file') {
    options.exported_posts_file = process.argv[i+1];
    i++;
  } else if (process.argv[i] == '--selected-posts-file') {
    options.selected_posts_file = process.argv[i+1];
    i++;
  } else if (process.argv[i].indexOf('--') == 0) {
    var arg = process.argv[i];
    if (arg.indexOf("=") > 0) {
      var arg_kv = arg.split('=');
      arg = arg_kv[0];
      arg = arg.replace('--','');
      arg = utils.replaceAll(arg, '-', '_');
      options[arg] = arg_kv[1];
    } else {
      arg = arg.replace('--','');
      arg = utils.replaceAll(arg, '-', '_');
      options[arg] = true;
    }
  } else {
    argv.push(process.argv[i]);
  }
}

if (argv.length < 1) {
  printUsage();
  process.exit();
}

process.on('SIGTERM', function() {
  process.exit();
});
process.on('SIGINT', function() {
  process.exit();
});

var data_dir = argv[0];
console.log('Data directory:', data_dir);

if (options.tag) {
  console.log('Tag:', options.tag);
}
if (options.reblog) {
  console.log('Reblogged from:', options.reblog);
}
if (options.origin) {
  console.log('Origin from:', options.origin);
}

var images_output_dir = path.join(data_dir, 'photos');

var downloads_cache = null;
var download_queue = new JobQueue(/*{debug: true}*/);

function isAlpha(ch){
  return /^[A-Z]$/i.test(ch);
}

function matchAny(string, array) {
  var no_matched = true;
  for (var i = 0; i < array.length; i++) {
    if (string.indexOf(array[i]) >= 0) {
      no_matched = false;
      break;
    }
  }
  return !no_matched;
}

function isUrlMatch(url, hosts) {
  if (Array.isArray(hosts)) {
    return matchAny(url, hosts);
  } else if (typeof hosts == 'string') {
    return (url.indexOf(hosts) >= 0);
  } else if (typeof hosts == 'function') {
    return hosts(url);
  } 
  return false;
}

var numberPadding = function(number, count, padding) {
  padding = padding || '0';
  var output = '' + number;
  if (count && output.length < count) {
    while (output.length < count) {
      output = padding + output;
    }
  }
  return output;
}

var dateFormat = function(date, format) {
  var output = format || '';
  output = output.replace('YYYY', '' + date.getFullYear());
  output = output.replace('MM', '' + numberPadding(date.getMonth(),2));
  output = output.replace('DD', '' + numberPadding(date.getDate(),2));
  output = output.replace('hh', '' + numberPadding(date.getHours(),2));
  output = output.replace('mm', '' + numberPadding(date.getMinutes(),2));
  output = output.replace('ss', '' + numberPadding(date.getSeconds(),2));
  return output;
}

var logDate = function() {
  return dateFormat(new Date(), 'YYYY/MM/DD hh:mm:ss');
}

var logger = {
  log: function(module) {
    if (typeof module == 'object') {
      console.log(chalk.grey('[' + logDate() + ']'), 
        chalk.magenta(module.id || module), 
        Array.prototype.slice.call(arguments,1).join(' ')
      );
    } else {
      console.log(chalk.grey('[' + logDate() + ']'), 
        Array.prototype.slice.call(arguments)
      );
    }
  },

  logInfo: function(module) {
    console.log(chalk.grey('[' + logDate() + ']'), 
      chalk.green(module.id || module), 
      Array.prototype.slice.call(arguments,1).join(' ')
    );
  },

  logDebug: function(module) {
    console.log(chalk.grey('[' + logDate() + ']'), 
      chalk.blue(module.id || module), 
      Array.prototype.slice.call(arguments,1).join(' ')
    );
  },

  logWarn: function(module) {
    console.log(chalk.grey('[' + logDate() + ']'), 
      chalk.yellow(module.id || module), 
      Array.prototype.slice.call(arguments,1).join(' ')
    );
  },

  logError: function(module) {
    console.log(chalk.grey('[' + logDate() + ']'), 
      chalk.red(module.id || module), 
      Array.prototype.slice.call(arguments,1).join(' ')
    );
  }
}

function executeCommand(cmd, args, callback) {
  var command = spawn(cmd, args || [], {maxBuffer: 1024 * 500});

  command.stdout.on('data', function (data) {
    // console.log(data.toString());
    logger.log({id: cmd}, data.toString());

    if (data.toString().indexOf('File downloaded:') == 0) {
      processReport({
        downloaded: true,
        file: data.toString().replace('File downloaded: ','').split(' [')[0]
      });
    }
  });

  command.stderr.on('data', function (data) {
    // console.log(data.toString());
    logger.logError({id: cmd}, data.toString());
  });

  command.on('exit', function (code) {
    // console.log('command exited with code ' + code.toString());
    if (code !== 0) {
      logger.logError({id: cmd}, 'command exited with code ' + code.toString());
      callback(new Error('command exited with code ' + code.toString()));
    } else {
      logger.logInfo({id: cmd}, 'command exited with code ' + code.toString());
      callback();  
    }
  });
}

function downloadImages(images, output_dir, done) {
  if (options.verbose) console.log('downloadImages');
  if (options.debug) console.log(images);

  downloader.downloadImages(images, {
    output_dir: output_dir,
    skip_if_exist: true,
    onDownloadFailed: function(err, data) {
      console.log('Download failed:', data.url);
      console.log(err.message);
    },
    onDownloadFinished: function(data) {
      console.log('Downloaded:', path.relative(output_dir, data.file));
    }
  }, function(err, images) {
    if (err) {
      console.log(err);
    }
    if (images) {
      processReport({
        downloaded: true,
        files: images
      });
    }
    done();
  });
}

function downloadPost(post, force) {

  if (post.type != 'photo') {
    console.log('Not support download post type:', post.type);
    return;
  }

  var post_url = post.url;

  // console.log('Post URL:', post_url);

  var download_info = downloads_cache.get(post_url);
  if (!force && download_info && download_info.downloaded) {
    return true;
  }

  if (options.verbose) console.log('Download post:', post_url);

  var photo_urls = post.photo_urls || [];

  if (post['photo-url-1280']) {
    photo_urls.push(post['photo-url-1280']);
  } 

  if (post['photos'] && post['photos'].length) {
    post['photos'].forEach(function(photo_info) {
      var photo_url = photo_info['photo-url-1280'] || photo_info['photo-url-500'];
      if (photo_url && photo_urls.indexOf(photo_url) == -1) {
        photo_urls.push(photo_url);
      }
    });
  }

  if (photo_urls.length == 0) {
    if (options.verbose) console.log('No photos.');
    return;
  }

  var download_output_dir = images_output_dir;

  downloads_cache.update(post_url, {
    reblog: post['reblogged-from-name'] || post.reblog,
    origin: post['reblogged-root-name'] || post.origin,
    tags: post.tags || [],
    photo_urls: photo_urls
  });

  download_queue.pushJob({
    post_url: post_url, 
    photo_urls: photo_urls,
    output_dir: download_output_dir
  }, function(args, done) {

    console.log('Download post:', args.post_url);
    downloadImages(args.photo_urls, args.output_dir, done);

  }, function(err) {
    if (err) {
      console.log(err);
      downloads_cache.update(post_url, {
        download_error: err.message,
        error_code: err.code,
        downloaded: true
      });
    } else {
      downloads_cache.update(post_url, {
        downloaded: true,
        downloaded_at: new Date()
      });
    }
    console.log('Download queue:', download_queue.jobCount());
  });
  return true;
}

///

function processReport(data) {
  if (typeof process.send == 'function') {
    process.send(data);
  }
}

function printStats() {

}

function gracefulShutdown() {
  console.log('');
  console.log('Exiting... Please wait');
  printStats();
  console.log('Done.');
  process.exit();
}

function _processPendingDownloads(options) {
  for (var post_url in downloads_cache.toMap()) {
    var download = downloads_cache.get(post_url);
    if (download && !download.downloaded) {
      if (options.verbose) console.log('Pending:', post_url);
      if (!options.tag && !options.reblog && !options.origin && !options.favorites && !options.selected_posts_file) {
        downloadPost({
          url: post_url,
          photo_urls: download.photo_urls,
          tags: download.tags,
          reblog: download.reblog,
          origin: download.origin
        }, true);
      } else if (options.tag && download.tags && download.tags.indexOf(options.tag) >= 0) {
        downloadPost({
          url: post_url,
          photo_urls: download.photo_urls,
          tags: download.tags,
          reblog: download.reblog,
          origin: download.origin
        }, true);
      } else if (options.reblog && download.reblog && download.reblog == options.reblog) {
        downloadPost({
          url: post_url,
          photo_urls: download.photo_urls,
          tags: download.tags,
          reblog: download.reblog,
          origin: download.origin
        }, true);
      }
    }
  }
}

function _downloadFromExportedPosts(options, done) {

  downloads_cache = new JsonStore({ file: path.join(data_dir, 'tumblr-downloads.json') });

  var exported_posts_file = options.exported_posts_file || path.join(data_dir, 'tumblr-posts-exported.json');
  if (!utils.fileExists(exported_posts_file)) {
    console.log(chalk.red('Exported posts file does not exist'));
    return done(new Error('Exported posts file does not exist'));
  }

  var favorites_cache = {};
  var favorites_file = options.favorites_file || path.join(data_dir, 'tumblr-favorites.json');
  if (options.favorites && utils.fileExists(favorites_file)) {
    favorites_cache = utils.loadFromJsonFile(favorites_file);
  }

  var selected_posts_cache = {};
  if (options.selected_posts_file && utils.fileExists(options.selected_posts_file)) {
    selected_posts_cache = utils.loadFromJsonFile(options.selected_posts_file);
  }

  _processPendingDownloads(options);

  var posts_count = 0;
  var exported_posts = utils.loadFromJsonFile(exported_posts_file);
  for (var post_id in exported_posts) {
    if (exported_posts[post_id].type != 'photo') continue;
    if (options.favorites && !favorites_cache[post_id]) continue;
    if (options.tag) {
      if (!post.tags) continue;
      if (post.tags.indexOf(options.tag) == -1) continue;
    }
    if (options.reblog) {
      if (!post['reblogged-from-name']) continue;
      if (post['reblogged-from-name'] != options.reblog) continue;
    }
    if (options.origin) {
      if (!post['reblogged-root-name']) continue;
      if (post['reblogged-root-name'] != options.origin) continue;
    }
    if (options.selected_posts_file && !selected_posts_cache[post_id]) continue;
    posts_count++;
    downloadPost(exported_posts[post_id]);
  }

  console.log('Posts count:', posts_count);

  done();
}

function _downloadPosts(options, done) {

  downloads_cache = new JsonStore({ file: path.join(data_dir, 'tumblr-downloads.json') });

  var posts_cache = new JsonStore({ file: path.join(data_dir, 'tumblr-posts.json') });
  var posts_store = new NeDB({
    filename: path.join(data_dir, 'tumblr-posts.db'),
    autoload: true
  });

  var favorites_cache = {};
  var favorite_posts_file = options.favorite_posts_file || path.join(data_dir, 'tumblr-favorites.json');
  if (options.favorites && utils.fileExists(favorite_posts_file)) {
    favorites_cache = utils.loadFromJsonFile(favorite_posts_file);
  }

  var selected_posts_cache = {};
  if (options.selected_posts_file && utils.fileExists(options.selected_posts_file)) {
    selected_posts_cache = utils.loadFromJsonFile(options.selected_posts_file);
  }

  var post_ids = [];
  for (var post_id in posts_cache.toMap()) {
    if (posts_cache.get(post_id).type != 'photo') continue;
    if (options.favorites && !favorites_cache[post_id]) continue;
    if (options.selected_posts_file && !selected_posts_cache[post_id]) continue;
    post_ids.push(post_id);
  }

  console.log('Posts count:', post_ids.length);

  _processPendingDownloads(options);

  var count = 0;
  var total = post_ids.length;
  async.eachSeries(post_ids, function(post_id, cb) {
    count++;
    // console.log('Progress:', count + '/' + total, post_id);
    posts_store.findOne({id: post_id}, function(err, post) {
      if (err) {
        console.log('Export post failed:', post_id);
        return cb(err);
      }
      if (post) {
        if (!options.tag && !options.reblog && !options.origin) {
          downloadPost(post);
        } else if (options.tag && post.tags && post.tags.indexOf(options.tag) >= 0) {
          // console.log('Progress:', count + '/' + total, post_id, post.tags);
          downloadPost(post);
        } else if (options.reblog && post['reblogged-from-name'] && post['reblogged-from-name'] == options.reblog) {
          // console.log('Progress:', count + '/' + total, post_id, options.reblog);
          downloadPost(post);
        } else if (options.origin && post['reblogged-root-name'] && post['reblogged-root-name'] == options.origin) {
          // console.log('Progress:', count + '/' + total, post_id, options.reblog);
          downloadPost(post);
        }
      }
      cb();
    });
  }, function(err) {
    if (err) {
      console.log(err);
      return done(err);
    } else {
      done();
    }
  });
}

if (options.exported_posts) {
  lockFile.lock(path.join(data_dir, 'tumblr.lock'), {}, function (err) {
    if (err) {
      console.log(err);
      process.exit(1);
    }

    process.on('exit', function() {
      lockFile.unlock(path.join(data_dir, 'tumblr.lock'), function (err) {
        if (err) {
          console.log(err);
        }
      });
    });

    _downloadFromExportedPosts(options, function(err) {
      if (err) {
        console.log(err);
        process.exit(1);
      }
    });
  });
} else {
  lockFile.lock(path.join(data_dir, 'tumblr.lock'), {}, function (err) {
    if (err) {
      console.log(err);
      process.exit(1);
    }

    process.on('exit', function() {
      lockFile.unlock(path.join(data_dir, 'tumblr.lock'), function (err) {
        if (err) {
          console.log(err);
        }
      });
    });

    _downloadPosts(options, function(err) {
      if (err) {
        console.log(err);
        process.exit(1);
      }
    });
  });
}

