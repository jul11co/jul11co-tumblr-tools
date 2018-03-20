// lib/tumblr-scraper.js

var path = require('path');
var urlutil = require('url');
var util = require('util');
var EventEmitter = require('events').EventEmitter;

var async = require('async');
var chalk = require('chalk');
var moment = require('moment');
var request = require('request');

var NeDB = require('nedb');
var lockFile = require('lockfile');

var JsonStore = require('jul11co-jsonstore');

var utils = require('jul11co-utils');

var post_fields = [
  "id", 
  "url", "url-with-slug", "slug",
  "type", // 'text', 'quote', 'photo', 'link', 'chat', 'video', or 'audio'.
  "date", "date-gmt",
  "unix-timestamp",
  "format",
  "reblog-key",
  "reblogged-from-url", "reblogged-from-name", "reblogged-from-title",
  "reblogged-root-url", "reblogged-root-name", "reblogged-root-title",
  "note-count",
  "tumblelog",
  // type == 'photo'
  "photo-caption",
  "width", "height",
  "photo-url-1280",
  "photo-url-500",
  "photo-url-100",
  "photo-url-75",
  "photos",
  // type == 'video'
  "video-caption",
  "video-source",
  "video-player",
  // type == 'answer'
  "question",
  "answer",
  // type == 'regular'
  "regular-title",
  "regular-body",
  // type == 'conversation'
  "conversation-title",
  "conversation-text",
  "conversation",
  // type == 'quote'
  "quote-text",
  "quote-source",
  // type == 'link'
  "link-text",
  "link-url",
  "link-description",
];

var post_exclude_fields = [
  "bookmarklet",
  "mobile",
  "feed-item",
  "is-submission",
  "reblogged_from_avatar_url_16",
  "reblogged_from_avatar_url_24",
  "reblogged_from_avatar_url_30",
  "reblogged_from_avatar_url_40",
  "reblogged_from_avatar_url_48",
  "reblogged_from_avatar_url_64",
  "reblogged_from_avatar_url_96",
  "reblogged_from_avatar_url_128",
  "reblogged_from_avatar_url_512",
  "reblogged_root_avatar_url_16",
  "reblogged_root_avatar_url_24",
  "reblogged_root_avatar_url_30",
  "reblogged_root_avatar_url_40",
  "reblogged_root_avatar_url_48",
  "reblogged_root_avatar_url_64",
  "reblogged_root_avatar_url_96",
  "reblogged_root_avatar_url_128",
  "reblogged_root_avatar_url_512",
  "video-player-500",
  "video-player-250",
];

function requestWithEncoding(options, callback) {
  var req_err = null;
  try {
    var req = request.get(options);

    req.on('response', function(res) {
      var chunks = [];

      res.on('data', function(chunk) {
        chunks.push(chunk);
      });

      res.on('end', function() {
        if (!req_err) {
          var buffer = Buffer.concat(chunks);
          var encoding = res.headers['content-encoding'];
          if (encoding == 'gzip') {
            zlib.gunzip(buffer, function(err, decoded) {
              callback(err, res, decoded && decoded.toString());
            });
          } else if (encoding == 'deflate') {
            zlib.inflate(buffer, function(err, decoded) {
              callback(err, res, decoded && decoded.toString());
            })
          } else {
            callback(null, res, buffer.toString());
          }
        }
      });
    });

    req.on('error', function(err) {
      console.log('requestWithEncoding:error');
      console.log(err);
      if (!req_err) {
        req_err = err;
        callback(err);
      }
    });
  } catch(e) {
    console.log('requestWithEncoding:exception');
    console.log(e);
    if (!req_err) {
      req_err = e;
      callback(e);
    }
  }
}

function downloadUrl(url, options, attempts, callback) {
  if (typeof options == 'function') {
    callback = options;
    options = {};
    attempts = 0;
  }
  if (typeof attempts == 'function') {
    callback = attempts;
    attempts = 0;
  }

  var request_url = url;

  var request_options = {
    url: request_url,
    headers: {
      'User-Agent': 'tumblr-dl'
    },
    timeout: 60000 /* 60 seconds */
  };
  requestWithEncoding(request_options, function(error, response, content) {
    if (error) {
      // console.log(error);
      attempts++;
      if (error.code == "ESOCKETTIMEDOUT" || error.code == "ETIMEDOUT" 
        || error.code == "ECONNRESET") {
        var max_attempts = options.max_attempts || 5;
        var backoff_delay = options.backoff_delay || 5000; // 5 seconds
        if (attempts < max_attempts) {
          console.log('Timeout! Retrying... (' + attempts + ')');
          setTimeout(function() {
            downloadUrl(url, options, attempts, callback);
          }, backoff_delay);
          return;
        }
      }
      return callback(error);
    }

    if (response.statusCode != 200) {
      return callback(new Error('Request failed with status code ' + response.statusCode));
    }

    var content_type = response.headers['content-type'];

    return callback(null, {
      requested_url: url,
      resolved_url: response.request.href,
      content_type: content_type,
      content: content
    });
  });
}

function saveFileSync(output_file, content, encoding) {
  var output_dir = path.dirname(output_file);
  utils.ensureDirectoryExists(output_dir);

  fs.writeFileSync(output_file, content, encoding || 'utf8');
}

function trimRightUntilChar(string, last_char) {
  var tmp = string.slice(0);
  var c = tmp.substr(tmp.length - 1);
  while(c != last_char) {
    tmp = tmp.slice(0, -1);
    c = tmp.substr(tmp.length - 1);
  }
  if (c == last_char) {
    tmp = tmp.slice(0, -1);
  }
  return tmp;
}

// https://www.tumblr.com/docs/en/api/v1
// API JSON URL : http://(YOU).tumblr.com/api/read/json
//
// The most recent 20 posts are included by default.
//
// GET Parameters (options):
//   start - The post offset to start from. The default is 0.
//   num - The number of posts to return. The default is 20, and the maximum is 50.
//   type - The type of posts to return. If unspecified or empty, all types of posts 
//          are returned. Must be one of 'text', 'quote', 'photo', 'link', 'chat', 'video', or 'audio'.
//   id - A specific post ID to return. Use instead of start, num, or type.
//   filter - Alternate filter to run on the text content. Allowed values:
//       'text' - Plain text only. No HTML.
//       'none' - No post-processing. Output exactly what the author entered. 
//            (Note: Some authors write in Markdown, which will not be converted to 
//             HTML when this option is used.)
//   tagged - Return posts with this tag in reverse-chronological order (newest first). 
//          Optionally specify chrono=1 to sort in chronological order (oldest first).
var getTumblrJson = function(base_url, options, callback) {
  if (typeof options == 'function') {
    callback = options;
    options = {};
  }

  options.num = options.num || 50;

  var api_json_url = base_url + '/api/read/json';
  if (base_url.substr(base_url.length-1) == '/') {
    api_json_url = base_url + 'api/read/json';
  }

  var query_string = '';
  if (options.id) {
    query_string += 'id=' + options.id;
  }
  if (options.type) {
    query_string += 'type=' + options.type;
  }
  if (options.start) {
    query_string += 'start=' + options.start;
  }
  if (options.num) {
    if (query_string != '') query_string += '&';
    query_string += 'num=' + options.num;
  }
  if (options.filter) {
    if (query_string != '') query_string += '&';
    query_string += 'filter=' + options.filter;
  }
  if (options.tagged) {
    if (query_string != '') query_string += '&';
    query_string += 'tagged=' + encodeURI(options.tagged);
  }
  if (options.tag) {
    if (query_string != '') query_string += '&';
    query_string += 'tagged=' + encodeURI(options.tag);
  }
  if (query_string != '') api_json_url += '?' + query_string;

  if (options.verbose) console.log('Tumblr JSON:', api_json_url);

  downloadUrl(api_json_url, {}, function(err, result) {
    if (err) {
      return callback(err);
    }
    if (!result.content) {
      return callback(new Error('Missing content'));
    }

    var tumblr_api_read = {};
    var content_json = '';
    if (result.content.indexOf('var tumblr_api_read = ') == 0) {
      content_json = result.content.replace('var tumblr_api_read = ', '');
      content_json = trimRightUntilChar(content_json, ';');
    }

    // saveFileSync('content.json', content_json);

    try {
      tumblr_api_read = JSON.parse(content_json);
    } catch(err) {
      console.log('Parse JSON error.');
      return callback(err);
    }

    callback(null, {
      requested_url: result.requested_url,
      resolved_url: result.resolved_url,
      json: tumblr_api_read
    });
  });
}

var TumblrScraper = function(opts) {
  EventEmitter.call(this);

  opts = opts || {};

  var posts_cache = null;
  var posts_store = null;

  var fetched_posts_count = 0;
  var new_posts_count = 0;

  var is_scraping = false;
  var destroy_requested = false;

  var blog_processing_count = 0;

  var self = this;

  self.destroy = function() {
    if (is_scraping) {
      destroy_requested = true;
    } else {
      if (posts_cache) posts_cache.exit();
      posts_store = null;
    }
  }

  self.busy = function() {
    return is_scraping;
  }

  var initPostsCache = function() {
    if (opts.output_dir) {
      utils.ensureDirectoryExists(opts.output_dir);
    }
    var posts_cache_file = path.join(opts.output_dir||'.', opts.posts_cache_file||'tumblr-posts.json');
    posts_cache = opts.posts_cache || new JsonStore({ file: posts_cache_file });
  }

  var initPostsStore = function() {
    if (opts.output_dir) {
      utils.ensureDirectoryExists(opts.output_dir);
    }
    var posts_store_file = path.join(opts.output_dir||'.', opts.posts_store_file||'tumblr-posts.db')
    posts_store = opts.posts_store || new NeDB({
      filename: posts_store_file,
      autoload: true
    });
  }

  function isNewPost(post_info) {
    return (!posts_cache.get(post_info.id));
  }

  function savePostInfo(post_info, callback) {
    if (!posts_cache.get(post_info.id)) {
      new_posts_count++;
      if (opts.verbose) {
        console.log(chalk.green('New post:'), chalk.bold(post_info.id), 
          chalk.grey(moment(new Date(post_info['unix-timestamp']*1000)).fromNow()), 
          post_info.type,
          utils.trimLeft(post_info.url)
        );
      }
      posts_cache.set(post_info.id, {
        url: post_info.url,
        type: post_info.type,
        added_at: new Date(),
        last_update: new Date()
      });
    } else {
      posts_cache.update(post_info.id, {
        url: post_info.url,
        type: post_info.type,
        last_update: new Date()
      });
    }

    var post_item = {};
    // for (var i = 0; i < post_fields.length; i++) {
    //   if (typeof post_info[post_fields[i]] != 'undefined') {
    //     post_item[post_fields[i]] = post_info[post_fields[i]];
    //   }
    // }
    for (var field in post_info) {
      if (post_exclude_fields.indexOf(field) == -1) {
        post_item[field] = post_info[field];
      }
    }
    if (!post_item.id) post_item.id = post_info.id;

    posts_store.findOne({id: post_item.id}, function(err, post) {
      if (err) return callback(err);

      if (!post) {
        posts_store.insert(post_item, function(err) {
          if (err) return callback(err);
          self.emit('new-post', post_info);
          callback(null, post);
        });
      } else {
        posts_store.update({id: post_item.id}, post_item, function(err) {
          if (err) return callback(err);
          callback(null, post);
        });
      }
    });
  }

  function savePosts(posts, callback) {
    async.eachSeries(posts, function(post, cb) {
      post.id = post.id || post.url;
      savePostInfo(post, cb);
    }, callback);
  }

  function processPostInfo(post, options, callback) {
    if (typeof options == 'function') {
      callback = options;
      options = {};
    }
    callback(); 
  }

  function processPagination(pagination, options, callback) {
    if (typeof options == 'function') {
      callback = options;
      options = {};
    }
    callback();
  }

  function processPageInfo(page_info, options, callback) {
    if (typeof options == 'function') {
      callback = options;
      options = {};
    }
    var asyncTasks = [];
    if (page_info.post) {
      asyncTasks.push(function(cb) {
        console.log(chalk.green('Post info'));
        console.log('URL:', page_info.post.url);
        var post = page_info.post;
        post.id = post.id || post.url;
        savePostInfo(post, function(err) {
          if (err) return cb(err);
          processPostInfo(post, options, cb);
        });
      });
    }
    if (page_info.posts) {
      asyncTasks.push(function(cb) {
        console.log(chalk.bold('' + page_info.posts.length + ' posts'));
        savePosts(page_info.posts, function(err) {
          if (err) return cb(err);
          cb();
        });
      });
    }
    if (page_info.pagination) {
      asyncTasks.push(function(cb) {
        console.log(chalk.green('Pagination'));
        console.log(page_info.pagination);
        processPagination(page_info.pagination, options, function(err) {
          if (err) return cb(err);
          cb();
        });
      });
    }
    if (asyncTasks.length == 0) return callback();
    async.series(asyncTasks, function(err){
      callback(err);
    });
  }

  function processBlogData(blog, data, options, callback) {

    // console.log(data);
    var asyncTasks = [];

    if (data.posts && data.posts.length) {
      data.posts.forEach(function(post_info) {
        // Store
        delete post_info['like-button'];
        delete post_info['reblog-button'];
      });

      asyncTasks.push(function(cb) {
        var posts = [];
        data.posts.forEach(function(post) {
          posts.push(post);
        });

        if (posts.length > 0) {
          console.log(chalk.bold('Scraped posts:'), posts.length);
          processPageInfo({ 
            url: blog,
            posts: posts
          }, options, cb);
        } else {
          console.log(chalk.green('No posts'));
          cb();
        }
      });
    }

    var posts_count = data.posts ? data.posts.length : 0;
    fetched_posts_count += posts_count;

    var posts_start = data['posts-start'];
    var posts_total = data['posts-total'];

    console.log('Fetching...', (posts_start+posts_count)+'/'+posts_total);

    if (asyncTasks.length == 0) return callback();

    var prev_new_posts_count = new_posts_count;

    async.series(asyncTasks, function(err){
      if (err) {
        console.error('Process blog data failed:', blog, chalk.yellow('start: ' + posts_start));
      } else {
        // console.log('Process blog data finished:', blog, chalk.yellow('start: ' + posts_start));
      }

      self.emit('progress', {
        posts_count: posts_count,
        posts_current: fetched_posts_count,
        posts_total: posts_total,
        new_posts_count: new_posts_count
      });

      if (options.stop_if_no_new_posts && prev_new_posts_count == new_posts_count) {
        console.log(chalk.bold('No new posts'));

        setTimeout(function() {
          callback(err);
        }, 1000);
      } else if (options.max_posts && fetched_posts_count >= options.max_posts) {
        console.log(chalk.bold('Excess max posts: ' + options.max_posts));

        setTimeout(function() {
          callback(err);
        }, 1000);
      } else if (posts_start+posts_count < posts_total) {
        console.log(chalk.bold('New posts:'), new_posts_count-prev_new_posts_count);

        // Next page of posts
        options.start = posts_start+posts_count;

        setTimeout(function() {
          processBlog(blog, options, function(err) {
            callback(err);
          });
        }, 1000);
      } else {
        setTimeout(function() {
          callback(err);
        }, 1000);
      }
    });
  }

  function processBlog(blog, options, callback) {
    if (typeof options == 'function') {
      callback = options;
      options = {};
    }

    if (!is_scraping && destroy_requested) {
      return callback(new Error('Scraper was destroyed'));
    }
    
    if (!is_scraping) is_scraping = true;
    blog_processing_count++;

    var base_url = options.base_url || 'https://' + blog + '.tumblr.com/';

    if (options.start) {
      console.log(chalk.magenta('Blog:'), blog, chalk.yellow('start: ' + options.start));
    } else {
      console.log(chalk.magenta('Blog:'), blog);
    }

    // console.log('Base URL:', base_url);

    getTumblrJson(base_url, options, function(err, data) {
      if (err) {
        blog_processing_count--;
        if (blog_processing_count == 0) {
          is_scraping = false;
          if (destroy_requested) self.destroy();
        }
        return callback(err);
      }
      if (!data || !data.json) {
        blog_processing_count--;
        if (blog_processing_count == 0) {
          is_scraping = false;
          if (destroy_requested) self.destroy();
        }
        return callback(new Error('Missing JSON data'));
      }
      processBlogData(blog, data.json, options, function(err) {
        blog_processing_count--;
        if (blog_processing_count == 0) {
          is_scraping = false;
          if (destroy_requested) self.destroy();
        }
        return callback(err);
      });
    });
  }

  ///

  self.isNewPost = function(post_info) {
    if (!posts_cache) initPostsCache();
    if (!posts_store) initPostsStore();
    return isNewPost(post_info);
  };

  self.savePostInfo = function(post_info, callback) {
    if (!posts_cache) initPostsCache();
    if (!posts_store) initPostsStore();
    return savePostInfo(post_info, callback);
  };

  self.savePosts = function(posts, callback) {
    if (!posts_cache) initPostsCache();
    if (!posts_store) initPostsStore();
    return savePosts(posts, callback);
  };

  // options: {
  //   start: Number,
  //   num: Number,
  //   tagged: String,
  //   type: String, // one of 'text', 'quote', 'photo', 'link', 'chat', 'video', or 'audio'
  // }
  self.scrapeBlog = function(blog, options, callback) {
    blog_processing_count = 0;
    new_posts_count = 0;
    fetched_posts_count = 0;
    if (!posts_cache) initPostsCache();
    if (!posts_store) initPostsStore();
    if (!options.num) options.num = 50;
    return processBlog(blog, options, callback);
  };

  self.getStats = function() {
    return {
      fetched_posts_count: fetched_posts_count,
      new_posts_count: new_posts_count
    };
  }

  var extractPostInfo = function(post_data, return_fields) {
    var post_info = {};
    return_fields = return_fields || post_fields;
    for (var i = 0; i < return_fields.length; i++) {
      if (typeof post_data[return_fields[i]] != 'undefined') {
        post_info[return_fields[i]] = post_data[return_fields[i]];
      }
    }
    return post_info;
  }

  // {
  //   start: Number,
  //   num: Number // default: 50
  // }
  self.getPosts = function(blog, options, callback) {
    var base_url = options.base_url || 'https://' + blog + '.tumblr.com/';

    getTumblrJson(base_url, options, function(err, data) {
      if (err) {
        return callback(err);
      }
      if (!data || !data.json) {
        return callback(new Error('Missing JSON data'));
      }
      if (data.json.posts && data.json.posts.length) {
        var posts = [];

        data.json.posts.forEach(function(post_info) {
          // Store
          delete post_info['like-button'];
          delete post_info['reblog-button'];
          // posts.push(extractPostInfo(post_info, post_fields));
          posts.push(post_info);
        });

        return callback(null, data.json);
      } else {
        return callback(null, {posts: []});
      }
    });
  }

}

util.inherits(TumblrScraper, EventEmitter);

module.exports = TumblrScraper;

