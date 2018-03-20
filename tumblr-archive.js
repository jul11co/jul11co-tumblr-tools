#!/usr/bin/env node

var path = require('path');
var fs = require('fs');
var chalk = require('chalk');
var async = require('async');
var moment = require('moment');

var lockFile = require('lockfile');

var utils = require('jul11co-utils');
var JobQueue = require('jul11co-jobqueue');

var spawn = require('child_process').spawn;
var fork = require('child_process').fork;

var prettySeconds = require('pretty-seconds');

// var Spinner = require('cli-spinner').Spinner;

// var spinner = new Spinner('%s');
// spinner.setSpinnerString('|/-\\');

function printUsage() {
  console.log('Usage: ');
  console.log('       tumblr-archive <https://BLOGNAME.tumblr.com | blogs/BLOGNAME> [--here] [OUTPUTDIR] [OPTIONS]');
  console.log('       tumblr-archive --blog BLOGNAME [OUTPUTDIR] [OPTIONS]');
  console.log('');
  console.log('       tumblr-archive --update [--here] [OPTIONS]');
  console.log('       tumblr-archive --list');
  console.log('       tumblr-archive --add <URL> [OPTIONS] [--scrape-interval=<SECONDS>]');
  console.log('       tumblr-archive --remove <URL>');
  console.log('');
  console.log('OPTIONS:');
  console.log('    Set custom path to sources.json');
  console.log('       tumblr-archive [...] --sources-file <path-to-sources.json>');
  console.log('');
  console.log('    Download posts');
  console.log('       tumblr-archive [...] -D, --download-posts');
  console.log('');
  console.log('    Exports posts');
  console.log('       tumblr-archive [...] -E, --export-posts');
  console.log('');
  console.log('    Set maximum posts for scraped');
  console.log('       tumblr-archive [...] --max-posts=NUM');
  console.log('       tumblr-archive [...] -M NUM');
  console.log('');
}
  
if (process.argv.length < 3) {
  printUsage();
  process.exit();
}

var options = {};
var argv = [];
for (var i = 2; i < process.argv.length; i++) {
  if (process.argv[i] == '--sources-file') {
    options.sources_file = process.argv[i+1];
    i++;
  } else if (process.argv[i] == '--download-posts' || process.argv[i] == '-D') {
    options.download_posts = true;
  } else if (process.argv[i] == '--export-posts' || process.argv[i] == '-E') {
    options.export_posts = true;
  } else if (process.argv[i] == '--max-posts' || process.argv[i] == '-M') {
    options.max_posts = process.argv[i+1];
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

process.on('SIGINT', function() {
  console.log("\nCaught interrupt signal");
  process.exit();
});

var verbose = false;
if (process.argv.indexOf('--verbose') != -1) {
  verbose = true;
}

if (typeof options.scrape_interval == 'string') {
  options.scrape_interval = parseInt(options.scrape_interval);
  if (isNaN(options.scrape_interval)) {
    console.log(chalk.red('invalid scrape interval'));
    process.exit();
  }
}

if (typeof options.scrape_delay == 'string') {
  options.scrape_delay = parseInt(options.scrape_delay);
  if (isNaN(options.scrape_delay)) {
    console.log(chalk.red('invalid scrape interval'));
    process.exit();
  }
}

if (typeof options.max_posts == 'string') {
  options.max_posts = parseInt(options.max_posts);
  if (isNaN(options.max_posts)) {
    console.log(chalk.red('invalid max posts'));
    process.exit();
  }
  console.log('Maximum posts:', options.max_posts);
}

var tumblr_sources_file_name = options.here ? 'tumblr-sources.json' : 'tumblr-blogs.json';

var default_scrape_delay = 5; // 5 secs
var default_scrape_interval = 60*30; // 30 minutes

var scrape_queue = new JobQueue();
var download_queue = new JobQueue();

var sources_store = {};
var tumblr_sources = {};

///

function getBlogName(tumblr_url) {
  return tumblr_url.replace('https://','').replace('http://','').split('/')[0].trim().replace('.tumblr.com','');
}

function timeStamp() {
  if (options.simple_log) return '';
  return moment().format('YYYY/MM/DD hh:mm');
}

function directoryExists(directory) {
  try {
    var stats = fs.statSync(directory);
    if (stats.isDirectory()) {
      return true;
    }
  } catch (e) {
  }
  return false;
}

function executeCommand(cmd, args, callback) {
  // if (!options.verbose) spinner.start();
  var command = spawn(cmd, args || [], {maxBuffer: 1024 * 500});

  if (options.verbose) {
    command.stdout.on('data', function (data) {
      console.log(chalk.yellow(cmd), data.toString());
    });

    command.stderr.on('data', function (data) {
      console.log(chalk.yellow(cmd), data.toString());
    });
  }

  command.on('exit', function (code) {
    // if (!options.verbose) spinner.stop(true);
    if (options.verbose) console.log(chalk.yellow(cmd), 'command exited with code ' + code.toString());
    if (code !== 0) {
      callback(new Error('command exited with code ' + code.toString()));
    } else {
      callback();  
    }
  });
}

function getDateString(date) {
  return moment(date).fromNow();
}

function executeScript(script, args, callback) {
  // if (!options.verbose) spinner.start();
  var cmd = path.basename(script,'.js');
  var command = fork(script, args || [], {silent: true});
  var start_time = new Date();

  if (options.verbose) {
    command.stdout.on('data', function (data) {
      console.log(chalk.grey(timeStamp()), chalk.yellow(cmd), data.toString());
    });

    command.stderr.on('data', function (data) {
      console.log(chalk.grey(timeStamp()), chalk.yellow(cmd), data.toString());
    });
  }

  command.on('message', function(data) {
    if (data.downloaded && data.file) {
      // if (spinner.isSpinning()) spinner.stop(true);
      console.log(chalk.grey(timeStamp()), chalk.magenta('downloaded'), data.file);
      // spinner.start();
    } 
    if (data.new_post && data.post_info && options.verbose) {
      // if (spinner.isSpinning()) spinner.stop(true);
      console.log(chalk.grey(timeStamp()), chalk.green('new post'), 
        chalk.grey(getDateString(new Date(data.post_info["unix-timestamp"]*1000))), 
        chalk.blue(data.post_info['url-with-slug']));
      // spinner.start();
    } 
    if (data.progress) {
      // if (spinner.isSpinning()) spinner.stop(true);
      console.log(chalk.grey(timeStamp()), chalk.cyan('progress'), 
        'total: ' + data.total_posts,
        'current: ' + data.current_posts,
        'new: ' + data.new_posts
        );
      // spinner.start();
    } 
    else if (data.scraped_stats) {
      if (typeof data.new_posts_count != 'undefined') {
        // if (spinner.isSpinning()) spinner.stop(true);
        console.log(chalk.grey(timeStamp()), chalk.bold('new posts'), data.new_posts_count);
        // spinner.start();
      }
    }
  });

  command.on('exit', function (code) {
    // if (!options.verbose) spinner.stop(true);
    if (options.verbose) {
      console.log(chalk.grey(timeStamp()), 
        chalk.yellow(cmd), 'command exited with code ' + code.toString());
    }
    var elapsed_seconds = moment().diff(moment(start_time),'seconds');
    console.log(chalk.grey(timeStamp()), chalk.grey('elapsed time'), prettySeconds(elapsed_seconds));
    if (code !== 0) {
      callback(new Error('command exited with code ' + code.toString()));
    } else {
      callback();  
    }
  });
}

function scrapeBlog(url, output_dir, opts, done) {
  if (typeof opts == 'function') {
    done = opts;
    opts = {};
  }
  var args = [
    url,
    output_dir,
  ];
  args.push('--stop-if-no-new-posts'); // same as -S
  // args.push('--verbose');
  // executeCommand('tumblr-scrape', args, done);
  if (typeof opts.max_posts != 'undefined') {
    args.push('--max-posts');
    args.push(opts.max_posts);
  }
  // console.log(args);
  executeScript(__dirname + '/tumblr-scrape.js', args, done);
}

function exportPosts(data_dir, done) {
  var args = [
    data_dir,
  ];
  // args.push('--verbose');
  executeCommand('tumblr-export-posts', args, done);
}

function downloadBlogPosts(data_dir, done) {
  var args = [
    data_dir,
  ];
  args.push('--exported-posts');
  // args.push('--verbose');
  // executeCommand('tumblr-download-posts', args, done);
  executeScript(__dirname + '/tumblr-download-posts.js', args, done);
}

///

function updateSource(source, output_dir, options) {
  options = options || {};

  if (tumblr_sources[source.url] && tumblr_sources[source.url].updating) {
    return;
  } else if (!tumblr_sources[source.url]) {
    tumblr_sources[source.url] = {};
  }
  tumblr_sources[source.url].updating = true;

  var skip_update = false;
  scrape_queue.pushJob(source, function(source, done) {

    if (options.verbose) {
      console.log(chalk.grey(timeStamp()), chalk.cyan('update source'), source.url, output_dir);
    }

    if (source.config && source.config.last_scraped) {
      var last_scraped = source.config.last_scraped;
      if (typeof last_scraped == 'string') {
        last_scraped = new Date(last_scraped);
      }
      
      var source_scrape_interval = (source.config.scrape_interval || default_scrape_interval) * 1000;
      var now = new Date();
      console.log(chalk.grey(timeStamp()), chalk.grey('last scraped'), source.url, moment(last_scraped).fromNow());

      if (!options.force && now.getTime() - last_scraped.getTime() < source_scrape_interval) {
        skip_update = true;
        return done();
      }
    }

    console.log(chalk.grey(timeStamp()), chalk.magenta('scrape source'), source.url);

    var blog = getBlogName(source.url);
    var blog_output_dir = output_dir;

    scrapeBlog(source.url, blog_output_dir, {max_posts: options.max_posts}, function(err) {
      if (err) {
        console.log(chalk.grey(timeStamp()), chalk.red('update failed.'), source_url);
        return done(err);
      }

      if (source.config) {
        source.config.last_scraped = new Date();
      }

      if (!source.config.no_export && (options.download_posts || options.export_posts)) {

        console.log(chalk.grey(timeStamp()), chalk.magenta('export posts'), blog);
        exportPosts(blog_output_dir, function(err) {
          if (err) {
            console.log(err);
            return done();
          }

          if (source.config.download_posts && options.download_posts) {
            download_queue.pushJob(source, function(source, done2) {
              console.log(chalk.grey(timeStamp()), chalk.magenta('download posts'), source.url);

              downloadBlogPosts(blog_output_dir, function(err) {
                if (err) {
                  console.log(chalk.grey(timeStamp()), chalk.red('download posts failed.'), source_url);
                  return done2(err);
                }
                setTimeout(done2, 1000);
                // cb();
              });
            }, function(err) {
              if (err) console.log(err);

              // console.log('');
              console.log(chalk.grey(timeStamp()), 'download queue', (download_queue.jobCount()-1));
            });
          }

          setTimeout(done, (source.config.scrape_delay || default_scrape_delay) * 1000);
        });
      } else {
        setTimeout(done, (source.config.scrape_delay || default_scrape_delay) * 1000);
      }
      // cb();
    });
  }, function(err) {
    if (err) console.log(err);

    tumblr_sources[source.url].updating = false;

    if (!skip_update && options.sources_file) {
      utils.saveToJsonFile(sources_store, options.sources_file);
    }

    // console.log('');
    // console.log('scrape queue', (scrape_queue.jobCount()-1));
  });
}

function updateSourcePeriodically(source, output_dir, interval, options) {
  setInterval(function() {
    updateSource(source, output_dir, options);
  }, interval);

  updateSource(source, output_dir, options);
}

function loadSourcesFromDir(data_dir) {
  if (utils.fileExists(path.join(data_dir, 'tumblr-sources.json'))) {
    var tumblr_info = utils.loadFromJsonFile(path.join(data_dir, 'tumblr-sources.json')) || {};
    for (var tumblr_url in tumblr_info) {
      if (!sources_store[tumblr_url]) {
        sources_store[tumblr_url] = tumblr_info[tumblr_url];
        sources_store[tumblr_url].output_dir = '.';
        console.log('Added blog:', tumblr_url);
      }
    }
  }
  var files = fs.readdirSync(path.join(data_dir, 'blogs'));
  for (var i = 0; i < files.length; i++) {
    var tumblr_config_file = path.join(data_dir, 'blogs', files[i], 'tumblr-sources.json');
    
    if (utils.fileExists(tumblr_config_file)) {
      // console.log('Load tumblr data:', tumblr_config_file);
      var tumblr_info = utils.loadFromJsonFile(tumblr_config_file) || {};
      for (var tumblr_url in tumblr_info) {
        if (!sources_store[tumblr_url]) {
          sources_store[tumblr_url] = tumblr_info[tumblr_url];
          sources_store[tumblr_url].output_dir = path.join('blogs', files[i]);
          console.log('Added blog:', tumblr_url);
        }
      }
    }
  }
}

function saveSourceConfig(source_url, source_config, output_dir) {
  var blog_name = getBlogName(source_url);
  var blog_data_dir = path.join(output_dir, 'blogs', blog_name);

  utils.ensureDirectoryExists(blog_data_dir);

  var tumblr_config_file = path.join(blog_data_dir, 'tumblr-sources.json');
  var tumblr_info = {};
  if (utils.fileExists(tumblr_config_file)) {
    tumblr_info = utils.loadFromJsonFile(tumblr_config_file) || {};
  }

  if (!tumblr_info[source_url]) {
    tumblr_info[source_url] = Object.assign({}, source_config);
    tumblr_info[source_url].output_dir = '.';
    console.log('Add blog:', source_url);
  } else {
    tumblr_info[source_url] = Object.assign(tumblr_info[source_url], source_config);
    tumblr_info[source_url].output_dir = '.';
    console.log('Update blog:', source_url);
  }
  
  utils.saveToJsonFile(tumblr_info, tumblr_config_file);
}

function leftPad(str, spaces) {
  if (!str) return '';
  if (str.length >= spaces) return str;
  while (str.length < spaces) {
    str = ' ' + str;
  }
  return str;
}

function rightPad(str, spaces) {
  if (!str) return '';
  if (str.length >= spaces) return str;
  while (str.length < spaces) {
    str += ' ';
  }
  return str;
}

function showSourceConfig(source_config) {
  for (var config_key in source_config) {
    if (config_key == 'added_at' || config_key == 'last_scraped') {
      var time_moment = moment(source_config[config_key]);
      console.log(chalk.green(leftPad(rightPad(config_key+':', 17),23)) 
        + time_moment.format('MMM DD, YYYY hh:mm A') + ' (' + time_moment.fromNow() + ')');
    } else {
      console.log(chalk.green(leftPad(rightPad(config_key+':', 17),23)) + source_config[config_key]);
    }
  }
}

var lastChar = function(str) {
  return str.substring(str.length-1);
}

var removeLastChar = function(str) {
  return str.substring(0, str.length-1);
}

function sortSources(sources, sort_field, sort_order) {
  if (sort_order=='desc') {
    sources.sort(function(a,b) {
      if (!b.config[sort_field]) return -1;
      else if (!a.config[sort_field]) return 1;
      else if (a.config[sort_field] > b.config[sort_field]) return -1;
      else if (a.config[sort_field] < b.config[sort_field]) return 1;
      return 0;
    });
  } else {
    sources.sort(function(a,b) {
      if (!b.config[sort_field]) return 1;
      else if (!a.config[sort_field]) return -1;
      else if (a.config[sort_field] > b.config[sort_field]) return 1;
      else if (a.config[sort_field] < b.config[sort_field]) return -1;
      return 0;
    });
  }
}

function _listSources(options) {
  var sources = [];
  for (var source_url in sources_store) {
    if (options.nsfw && !sources_store[source_url].nsfw) continue;
    sources.push({
      url: source_url, 
      name: getBlogName(source_url),
      config: sources_store[source_url]
    });
  }

  console.log(chalk.grey(timeStamp()), chalk.magenta('list sources'), sources.length);

  if (options.sort == 'url' || options.sort == 'name' 
    || options.sort == 'added_at' || options.sort == 'last_scraped') {

    var sort_field = options.sort;
    var default_order = (sort_field == 'added_at' || sort_field == 'last_scraped') ? 'desc' : 'asc';
    var sort_order = options.order || default_order;

    console.log('----');
    console.log('Sort by:', sort_field, 'order:', sort_order);
    sources.forEach(function(source) {
      if (source.config[sort_field] && (sort_field == 'added_at' || sort_field == 'last_scraped')) {
        source.config[sort_field] = new Date(source.config[sort_field]).getTime();
      }
      // console.log(source.config[sort_field]);
    });
    if (options.sort == 'added_at' || options.sort == 'last_scraped') {
      sortSources(sources, sort_field, sort_order);
    } else {
      if (sort_order=='desc') {
        sources.sort(function(a,b) {
          if (a[sort_field] > b[sort_field]) return -1;
          else if (a[sort_field] < b[sort_field]) return 1;
          return 0;
        });
      } else {
        sources.sort(function(a,b) {
          if (a[sort_field] > b[sort_field]) return 1;
          else if (a[sort_field] < b[sort_field]) return -1;
          return 0;
        });
      }
    }
  }
  console.log('----');

  var index = 0;
  sources.forEach(function(source) {
    index++;
    console.log(leftPad('' + index, 2) + '. ' + chalk.blue(source.name));
    showSourceConfig(source.config);
  })
}

function _addSources(sources_to_add, options) {
  var new_sources_count = 0;

  var sources_dir = path.dirname(options.sources_file);

  for (var i = 0; i < sources_to_add.length; i++) {
    var source_url = sources_to_add[i];
    if (source_url.slice(-1) == '/') {
      source_url = source_url.slice(0, source_url.length-1);
    }

    var blog_name = getBlogName(source_url);
    var blog_output_dir = options.here ? '.' : path.join('blogs', blog_name);

    if (sources_store[source_url]) {
      console.log(chalk.grey(timeStamp()), chalk.magenta('already added'), source_url);
      
      var source_config = sources_store[source_url];
      showSourceConfig(source_config);

      var update_source = false;
      if (options.scrape_interval && source_config.scrape_interval != options.scrape_interval) {
        source_config.scrape_interval = options.scrape_interval;
        update_source = true;
      }
      if (options.download_posts && source_config.download_posts != options.download_posts) {
        source_config.download_posts = true;
        update_source = true;
      }
      if (!source_config.output_dir || (source_config.output_dir != blog_output_dir)) {
        source_config.output_dir = blog_output_dir;
        update_source = true;
      }

      if (update_source) {
        sources_store[source_url] = source_config;
        console.log(chalk.grey(timeStamp()), chalk.green('update source'), source_url);

        showSourceConfig(source_config);
        saveSourceConfig(source_url, source_config, sources_dir);
      }
    } else {
      new_sources_count++;
      console.log(chalk.grey(timeStamp()), chalk.green('new source'), source_url);
      
      var source_config = {
        added_at: new Date()
      };
      if (options.scrape_interval) source_config.scrape_interval = options.scrape_interval;
      if (options.download_posts) source_config.download_posts = true;
      if (options.nsfw) source_config.nsfw = true;
      source_config.output_dir = blog_output_dir;

      sources_store[source_url] = source_config;

      showSourceConfig(source_config);
      saveSourceConfig(source_url, source_config, sources_dir);
    }
  }

  console.log('---');
  console.log(chalk.grey(timeStamp()), chalk.bold('new sources'), new_sources_count);

  if (options.sources_file) {
    utils.saveToJsonFile(sources_store, options.sources_file);
  }
}

function _removeSources(sources_to_remove, options) {
  var removed_sources_count = 0;

  for (var i = 0; i < sources_to_remove.length; i++) {
    var source_url = sources_to_remove[i];

    if (!sources_store[source_url]) {
      console.log(chalk.grey(timeStamp()), chalk.magenta('already removed'), source_url);
    } else {
      removed_sources_count++;
      console.log(chalk.grey(timeStamp()), chalk.red('remove source'), source_url);
      delete sources_store[source_url];
    }
  }

  console.log('---');
  console.log(chalk.grey(timeStamp()), chalk.bold('removed sources'), removed_sources_count);

  if (options.sources_file) {
    utils.saveToJsonFile(sources_store, options.sources_file);
  }
}

function _updateSource(source_url, options) {
  var source = {
    url: source_url
  };

  var sources_dir = path.dirname(options.sources_file);

  var blog_name = getBlogName(source_url);
  var blog_output_dir = options.here ? '.' : path.join('blogs', blog_name);

  if (sources_store[source_url]) {
    console.log(chalk.grey(timeStamp()), chalk.magenta('already added'), source_url);
    
    var source_config = sources_store[source_url];

    var update_source = false;
    if (options.scrape_interval && source_config.scrape_interval != options.scrape_interval) {
      source_config.scrape_interval = options.scrape_interval;
      update_source = true;
    }
    if (options.download_posts && source_config.download_posts != options.download_posts) {
      source_config.download_posts = true;
      update_source = true;
    }
    if (!source_config.output_dir || (source_config.output_dir != blog_output_dir)) {
      source_config.output_dir = blog_output_dir;
      update_source = true;
    }

    if (update_source) {
      sources_store[source_url] = source_config;
      // saveSourceConfig(source_url, source_config, sources_dir);
    }
  } else {
    console.log(chalk.grey(timeStamp()), chalk.green('new source'), source_url);
    
    var source_config = {
      added_at: new Date()
    };
    if (options.scrape_interval) source_config.scrape_interval = options.scrape_interval;
    if (options.download_posts) source_config.download_posts = true;
    source_config.output_dir = blog_output_dir;

    sources_store[source_url] = source_config;

    // saveSourceConfig(source_url, source_config, sources_dir);
  }

  source.config = sources_store[source_url] || {};

  if (options.debug) console.log(source.config);

  var source_output_dir = source.config.output_dir;
  if (options.here) {
    source_output_dir = '.';
  } else if (!source_output_dir) {
    var blog_name = getBlogName(source.url);
    source.config.output_dir = path.join('blogs', blog_name);
    source_output_dir = source.config.output_dir;
  }

  console.log(chalk.grey(timeStamp()), chalk.grey('blog dir'), source_output_dir);

  updateSource(source, path.join(sources_dir, source_output_dir), options);
}

function _updateSources(options) {
  var sources = [];

  for (var source_url in sources_store) {
    if (!sources_store[source_url].disable) {
      sources.push({
        url: source_url,
        config: sources_store[source_url]
      });
    }
  }

  console.log(chalk.grey(timeStamp()), chalk.magenta('update sources'), sources.length);

  var sources_dir = path.dirname(options.sources_file);

  for (var i = 0; i < sources.length; i++) {
    var source = {
      url: sources[i].url,
      config: Object.assign({}, sources[i].config)
    };

    var source_output_dir = source.config.output_dir;
    if (options.here) {
      source_output_dir = '.';
    } else if (!source_output_dir) {
      var blog_name = getBlogName(source.url);
      source.config.output_dir = path.join('blogs', blog_name);
      source_output_dir = source.config.output_dir;
    }

    updateSource(sources[i], path.join(sources_dir, source_output_dir), options);
  }
}

function _watchSources(options) {
  var sources = [];

  for (var source_url in sources_store) {
    if (!sources_store[source_url].disable) {
      sources.push({
        url: source_url,
        config: sources_store[source_url]
      });
    }
  }

  console.log(chalk.grey(timeStamp()), chalk.magenta('watch sources'), sources.length);

  var sources_dir = path.dirname(options.sources_file);

  for (var i = 0; i < sources.length; i++) {
    var source = {
      url: sources[i].url,
      config: sources[i].config
    };

    var source_scrape_interval = source.config.scrape_interval || options.scrape_interval;
    source_scrape_interval = source_scrape_interval || default_scrape_interval 
    source_scrape_interval = source_scrape_interval * 1000; // to ms

    var source_output_dir = source.config.output_dir;
    if (options.here) {
      source_output_dir = '.';
    } else if (!source_output_dir) {
      var blog_name = getBlogName(source.url);
      source.config.output_dir = path.join('blogs', blog_name);
      source_output_dir = source.config.output_dir;
    }

    updateSourcePeriodically({
      url: sources[i].url,
      config: sources[i].config
    }, path.join(sources_dir, source_output_dir), source_scrape_interval, options);
  }
}

////

if (options.update || options.update_sources) {

  var output_dir = argv[0] || '.';
  console.log('Work dir:', output_dir);

  console.log(chalk.grey(timeStamp()), chalk.cyan('scrape from sources'));

  options.sources_file = options.sources_file || path.join(output_dir, tumblr_sources_file_name);

  if (options.sources_file && utils.fileExists(options.sources_file)) {
    sources_store = utils.loadFromJsonFile(options.sources_file);
  }
  if (options.recursive && utils.directoryExists(path.join(output_dir, 'blogs'))) {
    loadSourcesFromDir(output_dir);
  }

  process.on('exit', function() {
    utils.saveToJsonFile(sources_store, options.sources_file);
  });

  _updateSources(options);
} 
else if (options.watch || options.watch_sources) {

  var output_dir = argv[0] || '.';
  console.log('Work dir:', output_dir);

  console.log(chalk.grey(timeStamp()), chalk.cyan('scrape from sources'));

  options.sources_file = options.sources_file || path.join(output_dir, tumblr_sources_file_name);

  if (options.sources_file && utils.fileExists(options.sources_file)) {
    sources_store = utils.loadFromJsonFile(options.sources_file);
  }
  if (options.recursive && utils.directoryExists(path.join(output_dir, 'blogs'))) {
    loadSourcesFromDir(output_dir);
  }

  process.on('exit', function() {
    utils.saveToJsonFile(sources_store, options.sources_file);
  });

  _watchSources(options);
} 
else if (options.list || options.list_sources) {

  var output_dir = argv[0] || '.';
  console.log('Work dir:', output_dir);

  console.log(chalk.grey(timeStamp()), chalk.cyan('list sources'));

  options.sources_file = options.sources_file || path.join(output_dir, tumblr_sources_file_name);

  if (options.sources_file && utils.fileExists(options.sources_file)) {
    sources_store = utils.loadFromJsonFile(options.sources_file);
  }
  
  _listSources(options);

  process.exit();
}
else if ((options.add || options.add_source) && argv.length) {
  var sources_to_add = [];
  for (var i = 0; i < argv.length; i++) {
    if (argv[i].indexOf('http') == 0 && sources_to_add.indexOf(argv[i]) == -1) {
      sources_to_add.push(argv[i]);
    }
  }
  sources_to_add = sources_to_add.map(function(source_url) {
    if (lastChar(source_url) == '/') {
      return removeLastChar(source_url);
    }
    return source_url;
  });

  var output_dir = '.';
  console.log('Work dir:', output_dir);

  console.log(chalk.grey(timeStamp()), chalk.cyan('add source(s)'));

  options.sources_file = options.sources_file || path.join(output_dir, tumblr_sources_file_name);

  if (options.sources_file && utils.fileExists(options.sources_file)) {
    sources_store = utils.loadFromJsonFile(options.sources_file);
  }

  _addSources(sources_to_add, options);

  process.exit();
} 
else if ((options.remove || options.remove_source) && argv.length) {
  var sources_to_remove = [];
  for (var i = 0; i < argv.length; i++) {
    if (argv[i].indexOf('http') == 0 && sources_to_remove.indexOf(argv[i]) == -1) {
      sources_to_remove.push(argv[i]);
    }
  }
  sources_to_remove = sources_to_remove.map(function(source_url) {
    if (lastChar(source_url) == '/') {
      return removeLastChar(source_url);
    }
    return source_url;
  });

  var output_dir = '.';
  console.log('Work dir:', output_dir);

  console.log(chalk.grey(timeStamp()), chalk.cyan('remove source(s)'));

  options.sources_file = options.sources_file || path.join(output_dir, tumblr_sources_file_name);

  if (options.sources_file && utils.fileExists(options.sources_file)) {
    sources_store = utils.loadFromJsonFile(options.sources_file);
  }

  _removeSources(sources_to_remove, options);

  process.exit();
} 
else if ((options.blog) && argv.length) {
  var blog_name = argv[0];
  var source_url = 'https://' + blog_name + '.tumblr.com';

  var output_dir = argv[1] || '.';
  console.log('Work dir:', output_dir);

  console.log(chalk.grey(timeStamp()), chalk.cyan('scrape from URL'), source_url);

  options.sources_file = options.sources_file || path.join(output_dir, tumblr_sources_file_name);

  if (options.sources_file && utils.fileExists(options.sources_file)) {
    sources_store = utils.loadFromJsonFile(options.sources_file);
  }

  _updateSource(source_url, options);
} 
else if (argv.length && (argv[0].indexOf('http') == 0 || argv[0].indexOf('blogs/') == 0)) {
  var source_url = argv[0];

  if (argv[0].indexOf('blogs/') == 0) {
    var blog = argv[0].replace('blogs/','').split('/')[0];
    source_url = 'https://' + blog + '.tumblr.com';
  }
  if (lastChar(source_url) == '/') {
    source_url = removeLastChar(source_url);
  }

  var output_dir = argv[1] || '.';
  console.log('Work dir:', output_dir);

  console.log(chalk.grey(timeStamp()), chalk.cyan('scrape from URL'), source_url);

  options.sources_file = options.sources_file || path.join(output_dir, tumblr_sources_file_name);

  if (options.sources_file && utils.fileExists(options.sources_file)) {
    sources_store = utils.loadFromJsonFile(options.sources_file);
  }

  _updateSource(source_url, options);
} else {
  printUsage();
  process.exit();
}

