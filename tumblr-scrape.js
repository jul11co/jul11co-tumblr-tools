#!/usr/bin/env node

var path = require('path');
var urlutil = require('url');

var async = require('async');
var chalk = require('chalk');

var lockFile = require('lockfile');

var JsonStore = require('jul11co-jsonstore');
var utils = require('jul11co-utils');

var TumblrScraper = require('./lib/tumblr-scraper');

function printUsage() {
  console.log('Usage: ');
  console.log('       tumblr-scrape <tumblr-url> [output-dir]');
  console.log('       tumblr-scrape --update [output-dir]');
  console.log('');
  console.log('OPTIONS:');
  console.log('       --verbose                 : verbose');
  console.log('');
  console.log('   -S, --stop-if-no-new-posts    : stop if current blog page has no new posts (default: not set)');
  console.log('   -M, --max-posts M             : set maximum posts that can be scraped');
  console.log('');
}

if (process.argv.length < 3) {
  printUsage();
  process.exit();
}

var options = {};
var argv = [];
for (var i = 2; i < process.argv.length; i++) {
  if (process.argv[i] == '--stop-if-no-new-posts' || process.argv[i] == '-S') {
    options.stop_if_no_new_posts = true;
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

if (argv.length < 1) {
  printUsage();
  process.exit();
}

if (typeof options.max_posts == 'string') {
  options.max_posts = parseInt(options.max_posts);
  if (isNaN(options.max_posts)) {
    console.log(chalk.red('invalid max posts'));
    process.exit();
  }
  console.log('Maximum posts:', options.max_posts);
}

var start_links = [];
for (var i = 0; i < argv.length; i++) {
  if (argv[i].indexOf('http') == 0) {
    var start_link = argv[i];
    console.log('Start link:', start_link);
    start_links.push(start_link);
  }
}

var output_dir = argv[1] || './';

function getBlogName(tumblr_url) {
  return tumblr_url.replace('https://','')
    .replace('http://','').split('/')[0].trim().replace('.tumblr.com','');
}

if (options.update) {
  output_dir = argv[0]; 

  if (!utils.fileExists(path.join(output_dir, 'tumblr-sources.json'))) {
    console.log('Invalid output directory, tumblr-sources.json not found!');
    process.exit();
  }
} else {
  if (start_links.length == 1) {
    // var blog = getBlogName(start_links[0]);
    // output_dir = path.join(output_dir, 'blogs', blog);
    
    if (start_links[0].indexOf('/tagged/') != -1) {
      var index = argv[0].indexOf('/tagged/');
      var start_url = argv[0].substring(0, index);

      options.tagged = argv[0].substring(index + 8);
      console.log('Tag:', options.tagged);

      output_dir = path.join(output_dir, options.tagged);
    }
  }
}

var lastChar = function(str) {
  return str.substring(str.length-1);
}

var removeLastChar = function(str) {
  return str.substring(0, str.length-1);
}

//

function processReport(data) {
  if (typeof process.send == 'function') {
    process.send(data);
  }
}

function scrapeLinks(links, output_dir, sources_store, options, callback) {

  // console.log('scrapeLinks');
  // console.log(links);

  var tumblr_scraper = new TumblrScraper({
    output_dir: output_dir
  });

  tumblr_scraper.on('new-post', function(data) {
    processReport({
      new_post: true,
      post_info: data
    });
  });
  
  tumblr_scraper.on('progress', function(data) {
    processReport({
      progress: true,
      new_posts: data.new_posts_count,
      total_posts: data.posts_total,
      current_posts: data.posts_current
    })
  });

  function printStats() {
    var stats = tumblr_scraper.getStats();
    console.log('New posts count:', stats.new_posts_count);

    processReport({
      scraped_stats: true,
      new_posts_count: stats.new_posts_count
    });
  }

  function gracefulShutdown() {
    console.log('');
    console.log('Exiting... Please wait');
    printStats();
    console.log('Done.');
    process.exit();
  }

  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT' , gracefulShutdown);

  async.eachSeries(links, function(link, cb) {
    console.log(link);

    if (link.indexOf('tumblr.com') != -1) {
      var blog = getBlogName(link);

      // console.log('Scrape blog:', blog);

      tumblr_scraper.scrapeBlog(blog, options, function(err) {
        if (!err) {
          sources_store.update(link, {last_update: new Date()}, true);
        }
        cb(err);
      });
    } else {
      cb();
    }
  }, function(err) {
    printStats();
    callback(err);
  });
}

//

if (options.update) {

  utils.ensureDirectoryExists(output_dir);

  lockFile.lock(path.join(output_dir, 'tumblr.lock'), {}, function (err) {
    if (err) {
      console.log(err);
      process.exit(1);
    }

    var sources_store = new JsonStore({ file: path.join(output_dir, 'tumblr-sources.json') });
    for (var source_link in sources_store.toMap()) {
      if (start_links.indexOf(source_link) == -1) {
        start_links.push(source_link);
      }
    }

    scrapeLinks(start_links, output_dir, sources_store, options, function(err) {
      var scrape_err = err;

      lockFile.unlock(path.join(output_dir, 'tumblr.lock'), function (err) {
        if (err) {
          console.log(err);
        }

        if (scrape_err) {
          console.log(scrape_err);
          process.exit(1);
        } else {
          console.log('Done.');
          process.exit(0);
        }
      });
    });
  });
} else if (start_links.length) {

  utils.ensureDirectoryExists(output_dir);

  lockFile.lock(path.join(output_dir, 'tumblr.lock'), {}, function (err) {
    if (err) {
      console.log(err);
      process.exit(1);
    }

    var sources_store = new JsonStore({ file: path.join(output_dir, 'tumblr-sources.json') });
    start_links = start_links.map(function(start_link) {
      if (lastChar(start_link) == '/') {
        start_link = removeLastChar(start_link);
      }
      if (!sources_store.get(start_link)) {
        sources_store.set(start_link, {added_at: new Date()});
      }
      return start_link;
    });

    scrapeLinks(start_links, output_dir, sources_store, options, function(err) {
      if (err) {
        console.log(err);
      }

      lockFile.unlock(path.join(output_dir, 'tumblr.lock'), function (err) {
        if (err) {
          console.log(err);
        }
        if (err) {
          console.log(err);
          process.exit(1);
        } else {
          console.log('Done.');
          process.exit(0);
        }
      });
    });
  });
} else {
  printUsage();
  process.exit(0);
}
