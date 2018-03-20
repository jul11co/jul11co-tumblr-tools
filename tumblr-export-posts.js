#!/usr/bin/env node

var async = require('async');
var path = require('path');
var chalk = require('chalk');

var NeDB = require('nedb');
var lockFile = require('lockfile');

var JsonStore = require('jul11co-jsonstore');
var utils = require('jul11co-utils');

function printUsage() {
  console.log('Usage: tumblr-export-posts <data-dir> [OPTIONS]');
  console.log('');
  console.log('OPTIONS:');
  console.log('     --verbose                        : verbose');
  console.log('');
}

if (process.argv.indexOf('-h') >= 0 
  || process.argv.indexOf('--help') >= 0
  || process.argv.length < 3) {
  printUsage();
  process.exit();
}

var options = {
  verbose: false,
};

if (process.argv.indexOf('--verbose') >= 0) {
  options.verbose = true;
}

var data_dir = process.argv[2] || './';

var posts_cache = null;
var posts_store = null;

var exported_posts_cache = null;
var exported_posts_count = 0;

function getPostInfo(post_id, callback) {
  posts_store.findOne({id: post_id}, function(err, post) {
    if (err) return callback(err);
    callback(null, post);
  });
}

function exportPosts(post_ids, options, callback) {
  if (typeof options == 'function') {
    callback = options;
    options = {};
  }
  
  var count = 0;
  var total = post_ids.length;
  async.eachSeries(post_ids, function(post_id, cb) {
    count++;
    console.log('Progress:', count + '/' + total, post_id);
    getPostInfo(post_id, function(err, post) {
      if (err) {
        console.log('Export failed:', post_id);
        return cb(err);
      }
      if (post) {
        exported_posts_count++;
        exported_posts_cache.set(post_id, post);
      }
      cb();
    })
  }, function(err) {
    callback(err);
  });
}

function printStats() {
  console.log('Exported posts count:', exported_posts_count);
}

lockFile.lock(path.join(data_dir, 'tumblr.lock'), {}, function (err) {
  if (err) {
    console.log(err);
    process.exit(1);
  }

  posts_cache = new JsonStore({ file: path.join(data_dir, 'tumblr-posts.json') });
  posts_store = new NeDB({
    filename: path.join(data_dir, 'tumblr-posts.db'),
    autoload: true
  });

  exported_posts_cache = new JsonStore({ file: path.join(data_dir, 'tumblr-posts-exported.json') });

  var post_ids = [];
  for (var post_id in posts_cache.toMap()) {
    post_ids.push(post_id);
  }

  console.log('Posts count:', post_ids.length);

  exportPosts(post_ids, options, function(err) {
    var export_err = err;

    lockFile.unlock(path.join(data_dir, 'tumblr.lock'), function (err) {
      if (err) {
        console.log(err);
      }

      printStats();

      if (export_err) {
        console.log(export_err);
        process.exit(1);
      } else {
        console.log('Done.');
        process.exit();
      }
    });
  });
});