#!/usr/bin/env node

var path = require('path');
var fs = require('fs');
var urlutil = require('url');

var async = require('async');
var fse = require('fs-extra');
var chalk = require('chalk');
var moment = require('moment');
var bytes = require('bytes');
var open = require('open');

var NeDB = require('nedb');
var lockFile = require('lockfile');

var spawn = require('child_process').spawn;

var express = require('express');
var session = require('express-session');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser');

var JsonStore = require('jul11co-jsonstore');
var JobQueue = require('jul11co-jobqueue');

var downloader = require('jul11co-wdt').Downloader;

var utils = require('jul11co-utils');

var TumblrScraper = require('./lib/tumblr-scraper');

function printUsage() {
  console.log('Usage: tumblr-browse-posts <DATADIR> [--recursive] [OPTIONS]');
  console.log('       tumblr-browse-posts --blogs [--blogs-file /path/to/tumblr-blogs.json] [OPTIONS]');
  console.log('');
  console.log('       tumblr-browse-posts --live <DATADIR> [OPTIONS]');
  console.log('       tumblr-browse-posts --live blogs/BLOG [OPTIONS]');
  console.log('       tumblr-browse-posts --live https://BLOG.tumblr.com/ [OPTIONS]');
  console.log('');
  console.log('       tumblr-browse-posts --config');
  console.log('       tumblr-browse-posts --config --secure [true|false]');
  console.log('       tumblr-browse-posts --config --password PASSWORD');
  console.log('');
  console.log('OPTIONS:');
  console.log('     --verbose                   : verbose');
  console.log('     --no-cache                  : do not cache photos,...');
  console.log('     --no-download               : do not download posts');
  console.log('');
}

if (process.argv.indexOf('-h') >= 0 
  || process.argv.indexOf('--help') >= 0
  || process.argv.length < 3) {
  printUsage();
  process.exit();
}

var options = {};
var argv = [];
for (var i = 2; i < process.argv.length; i++) {
  if (process.argv[i] == '--blogs-file') {
    options.blogs_file = process.argv[i+1];
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

// console.log(options);

if (argv.length < 1 && !options.blogs && !options.blogs_file && !options.config) {
  printUsage();
  process.exit();
}

process.on('SIGTERM', function() {
  process.exit();
});
process.on('SIGINT', function() {
  process.exit();
});

function getUserHome() {
  return process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'];
}

var config_dir = path.join(getUserHome(), '.jul11co', 'tumblr-tools');
var cache_dir = path.join(config_dir, 'cache');
if (options.local_cache) {
  cache_dir = path.join(data_dir, '_cache');
}
fse.ensureDirSync(cache_dir);

var browse_config = {};
var browse_config_file = path.join(config_dir, 'browse_config.json');
if (utils.fileExists(browse_config_file)) {
  browse_config = utils.loadFromJsonFile(browse_config_file);
}

if (options.config) {
  if (options.secure) {
    if (argv[0] == 'false') browse_config.secure = false;
    else browse_config.secure = true;
    console.log(browse_config);
    utils.saveToJsonFile(browse_config, browse_config_file, {backup: true});
    console.log('Config saved.');
    process.exit();
  } else if (options.password) {
    browse_config.password = utils.md5Hash(argv.join(' '));
    console.log(browse_config);
    utils.saveToJsonFile(browse_config, browse_config_file, {backup: true});
    console.log('Config saved.');
    process.exit();
  } else {
    console.log(browse_config);
    process.exit();
  }
}

function getBlogName(tumblr_url) {
  return tumblr_url.replace('https://','').replace('http://','').split('/')[0].trim().replace('.tumblr.com','');
}

var data_dir = '.';
if (options.blogs || options.blogs_file) {
  if (options.blogs_file) {
    data_dir = path.dirname(options.blogs_file);
  } else {
    data_dir = '.';
    options.blogs_file = path.join(data_dir, 'tumblr-blogs.json');
  }
  data_dir = path.resolve(data_dir);
} else if (options.live && argv[0].indexOf('http') == 0) {
  var blog_name = getBlogName(argv[0]);
  data_dir = path.resolve(path.join('.', 'blogs', blog_name));
} else if (options.live && argv[0].indexOf('blogs/') == 0) {
  var blog_name = argv[0].replace('blogs/','').split('/')[0];
  data_dir = path.resolve(path.join('.', 'blogs', blog_name));
} else {
  data_dir = path.resolve(argv[0] || '.');
}
console.log('Data directory:', data_dir);

if (options.live) {
  console.log('LIVE mode!');
}

var features = {
  enable_download: !options.no_download,
  enable_archive: !options.no_archive,
};

var io = null;

var tumblr_scraper = null;
var scraping_queue = new JobQueue();
var is_scraping = false;

var current_blog = '';
var tumblr_blogs = [];
var tumblr_blogs_map = {};

var live_posts_cache = {};

var posts_store = null;
var favorites_cache = null;

var download_photo_queue = new JobQueue();
var download_post_queue = new JobQueue();

var listen_port = 31112;
var server_started = false;

var posts_count = 0;
var photo_posts_count = 0;
var video_posts_count = 0;
var regular_posts_count = 0;
var conversation_posts_count = 0;
var quote_posts_count = 0;
var chat_posts_count = 0;
var link_posts_count = 0;
var audio_posts_count = 0;
var favorite_posts_count = 0;

var reblogs_map = {};
var blogs_map = {};
var years_map = {};

var posts_map = {};
// var post_tags_map = {};
var tags_map = {};
var all_tags = [];
var tags_graph = {};

var all_tags = [];
var all_reblogs = [];
var all_blogs = [];
var all_years = [];

var popular_tags = [];
var popular_reblogs = [];
var popular_blogs = [];
var popular_years = [];

///

function getPostsCount(condition, callback) {
  posts_store.count(condition, function(err, count) {
    if (err) return callback(err);
    callback(null, count);
  });
}

function getPostInfo(post_id, callback) {
  posts_store.findOne({id: post_id}, function(err, post) {
    if (err) return callback(err);
    callback(null, post);
  });
}

function getPosts(condition, options, callback) {
  var skip = options.skip || 0;
  var limit = options.limit|| 100;
  var sort = options.sort || {created_utc: -1};
  // console.log('getPosts:', skip, limit, sort);
  posts_store.find(condition).sort(sort).skip(skip).limit(limit).exec(function(err, posts) {
    callback(err, posts);
  });
}

var getLivePosts = function(blog, opts, callback) {

  if (!tumblr_scraper) {
    tumblr_scraper = new TumblrScraper({
      output_dir: data_dir,
      posts_store: posts_store
    });
    // tumblr_scraper.on('new-post', function(post_info) {
    //   console.log('New post:', post_info.id);
    // });
  }

  var cache_key = blog+':'+utils.md5Hash(JSON.stringify(opts));
  // console.log('Cache key:', cache_key);
  if (live_posts_cache[cache_key]) {
    if (timeToNow(live_posts_cache[cache_key].cached_at) < 900000) { // 15*60*1000 = 15 minutes
      return callback(null, live_posts_cache[cache_key].data);
    }
  }

  tumblr_scraper.getPosts(blog, opts, function(err, result) {
    if (err) return callback();
    if (!result || !result.posts) {
      return callback(null, result);
    }

    var new_posts = result.posts.filter(function(post_info) {
      return tumblr_scraper.isNewPost(post_info);
    });
    if (new_posts.length) {
      // console.log('New posts:', new_posts.length);
      // update index
      updatePostsIndex(new_posts);
      // update tumblr list
      updateTumblrListFromPosts(new_posts);
    }

    live_posts_cache[cache_key] = {
      cached_at: new Date(),
      data: result
    };

    tumblr_scraper.savePosts(result.posts, function(err) {
      return callback(null, result);
    });
  });
}

///

var timeToNow = function(date) {
  return (new Date().getTime() - date.getTime());
}

var escapeRegExp = function(string) {
  if (!string) return '';
  return string.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, "\\$1");
}

var replaceAllChars = function(string, chars, replace) {
  for (var i = 0; i < chars.length; i++) {
    string = string.replace(new RegExp(escapeRegExp(chars[i]), 'g'), replace)
  }
  return string;
}

function isUpperCase(c) {
    // return ((c >= 'A') && (c <= 'Z'));
    return c != '' && c == c.toUpperCase();
}

function isNumeric(string){
  return !isNaN(string)
}

var extractCapitalizedWords = function(string) {

  var capitalized_words = [];

  string = replaceAllChars(string, '?\'‘’-:,.(){}[]—_“”&#;\"\/《》「」【】', "|");
  // console.log('String (partitioned):', string);

  var partitions = string.split('|');
  // console.log('Partitions:', partitions.length);
  // console.log(partitions);

  var words = [];
  var tmp_w = [];

  partitions.forEach(function(part) {
    if (part == '') return;

    words = part.split(' ');
    tmp_w = [];

    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      var first_c = w.slice(0,1);
      if (/*!isNumeric(w) && */isUpperCase(first_c)) {
        tmp_w.push(w);
      } else if (tmp_w.length) {
        var new_w = tmp_w.join(' ');
        if (capitalized_words.indexOf(new_w) == -1) capitalized_words.push(new_w);
        tmp_w = [];
      }
    }
    if (tmp_w.length) {
      var new_w = tmp_w.join(' ');
      if (capitalized_words.indexOf(new_w) == -1) capitalized_words.push(new_w);
      tmp_w = [];
    }
  });

  // console.log('Capilized words:', capitalized_words.length);
  // console.log(capitalized_words);

  return capitalized_words;
}

function ellipsisMiddle(str, max_length, first_part, last_part) {
  if (!max_length) max_length = 140;
  if (!first_part) first_part = 40;
  if (!last_part) last_part = 20;
  if (str.length > max_length) {
    return str.substr(0, first_part) + '...' + str.substr(str.length-last_part, str.length);
  }
  return str;
}

var sortItems = function(items, field, order) {
  if (order == 'desc') {
    items.sort(function(a,b) {
      if (a[field] > b[field]) return -1;
      if (a[field] < b[field]) return 1;
      return 0;
    });
  } else {
    items.sort(function(a,b) {
      if (a[field] > b[field]) return 1;
      if (a[field] < b[field]) return -1;
      return 0;
    });
  }
}

function executeCommand(cmd, args, opts, callback) {
  if (typeof opts == 'function') {
    callback = opts;
    opts = {};
  }

  var command = spawn(cmd, args || [], {maxBuffer: 1024 * 500});

  if (opts.verbose) {
    command.stdout.on('data', function (data) {
      console.log(chalk.yellow(cmd), data.toString());
    });

    command.stderr.on('data', function (data) {
      console.log(chalk.yellow(cmd), data.toString());
    });
  }

  command.on('exit', function (code) {
    if (opts.verbose) console.log(chalk.yellow(cmd), 'command exited with code ' + code.toString());
    if (code !== 0) {
      callback(new Error('command exited with code ' + code.toString()));
    } else {
      callback();  
    }
  });
}

var buildSearchCondition = function(query, search_field) {
  var condition = {};
  search_field = search_field || 'name';
  var queries = query.split(' ');
  if (queries.length == 1) {
    condition[search_field] = new RegExp(escapeRegExp(query), 'i');
  } else {
    condition.$and = [];
    queries.forEach(function(q) {
      var cond = {};
      cond[search_field] = new RegExp(escapeRegExp(q), 'i');
      condition.$and.push(cond);
    });
  }
  return condition;
}

var startServer = function(done) {
  done = done || function() {};

  if (server_started) return done();

  console.log('Starting server...');

  var app = express();

  // view engine setup
  app.set('views', path.join(__dirname, 'views'));
  app.set('view engine', 'ejs');
  app.use(session({
    secret: 'jul11co-tumblr-posts-browser',
    resave: true,
    saveUninitialized: true
  }));
  app.use(bodyParser.json());
  app.use(bodyParser.urlencoded({extended: true}));
  app.use(cookieParser());
  app.use(express.static(path.join(__dirname, 'public')));
  app.use(express.static(cache_dir));
  app.use(express.static(data_dir));

  // Authentication Middleware

  var auth = function(req, res, next) {
    if (!browse_config['secure'] && !browse_config['password']) {
      return next();
    } else if (req.session && req.session.loggedIn) {
      return next();
    } else {
      req.session.redirectUrl = req.originalUrl;
      return res.redirect('/login');
    }
  };

  var verifyPassword = function(password, verify_hash) {
    return utils.md5Hash(password) == verify_hash;
  }

  app.get('/login', function(req, res, next) {
    if (!browse_config['secure'] && !browse_config['password']) {
      return res.redirect('/');
    } else if (req.session && req.session.loggedIn) {
      return res.redirect('/');
    } else {
      res.render('login', {
        query: req.query
      });
    }
  });
   
  app.post('/login', function (req, res) {
    if (!browse_config['secure'] && !browse_config['password']) {
      req.session.loggedIn = true;
      if (req.session.redirectUrl) {
        var redirectUrl = req.session.redirectUrl;
        delete req.session.redirectUrl;
        return res.redirect(redirectUrl);
      }
      return res.redirect('/');
    }
    if (!req.body.password || !verifyPassword(req.body.password, browse_config['password'])) {
      console.log('login failed');
      res.redirect('/login');
    } else {
      console.log('login success');
      req.session.loggedIn = true;
      if (req.session.redirectUrl) {
        var redirectUrl = req.session.redirectUrl;
        delete req.session.redirectUrl;
        return res.redirect(redirectUrl);
      }
      res.redirect('/');
    }
  });

  app.get('/logout', function(req, res, next) {
    req.session.loggedIn = false;
    res.redirect('/');
  });

  var displayArchivedPosts = function(req, res, next) {

    var opts = {};
    opts.limit = req.query.limit ? parseInt(req.query.limit) : 100;
    opts.skip = req.query.skip ? parseInt(req.query.skip) : 0;
    var sort_field = req.query.sort || req.session.sort || 'unix-timestamp';
    var sort_order = req.query.order || req.session.order || 'desc';
    opts.sort = {};
    if (sort_order == 'desc') {
      opts.sort[sort_field] = -1;
    } else {
      opts.sort[sort_field] = 1;
    }

    var query = req.query;
    if (req.query.sort && req.session.sort != req.query.sort) req.session.sort = req.query.sort;
    if (req.query.order && req.session.order != req.query.order) req.session.order = req.query.order;
    if (!req.query.sort) {
      query.sort = req.session.sort || sort_field;
      query.order = query.order || req.session.order || sort_order;
    }

    var condition = {};
    if (req.query.photos) condition.type = 'photo';
    if (req.query.videos) condition.type = 'video';
    if (req.query.regular) condition.type = 'regular';
    if (req.query.conversations) condition.type = 'conversation';
    if (req.query.chats) condition.type = 'chat';
    if (req.query.quotes) condition.type = 'quote';
    if (req.query.links) condition.type = 'link';
    if (req.query.audio) condition.type = 'audio';
    if (req.query.reblog) condition['reblogged-from-name'] = req.query.reblog;
    if (req.query.origin) condition['reblogged-root-name'] = req.query.origin;
    if (req.query.blog) condition['tumblelog.name'] = req.query.blog;
    if (req.query.year) {
      var year = parseInt(req.query.year);
      var m = moment({year: year, month: 0, day: 1});
      condition['unix-timestamp'] = {
        $gte: Math.round(m.startOf('year').toDate().getTime()/1000),
        $lte: Math.round(m.endOf('year').toDate().getTime()/1000)
      };
    }
    if (req.query.q) {
      condition = buildSearchCondition(req.query.q, 'slug');
    }

    // console.log(condition);
    // console.log(opts);

    var tumblr_starred_blogs = tumblr_blogs.filter(function(blog) {
      return blog.starred;
    });
    var tumblr_unstarred_blogs = tumblr_blogs.filter(function(blog) {
      return !blog.starred;
    });

    var tumblr_blog_grouped = false;
    var tumblr_blog_groups = {};
    if (tumblr_blogs.length > 150) {
      tumblr_blog_grouped = true;
      var first_char = '';
      tumblr_blogs.forEach(function(blog) {
        if (blog.starred) return;
        first_char = blog.name[0].toUpperCase();
        if (!isNaN(parseInt(first_char))) first_char = '#';
        if (!tumblr_blog_groups[first_char]) tumblr_blog_groups[first_char] = [];
        tumblr_blog_groups[first_char].push(blog); 
      });
    }

    var render_params = {
      query: query,
      features: features,
      is_live: options.live,
      live_posts: false,
      tumblr_blogs: tumblr_blogs,
      tumblr_starred_blogs: tumblr_starred_blogs,
      tumblr_unstarred_blogs: tumblr_unstarred_blogs,
      tumblr_blog_grouped: tumblr_blog_grouped,
      tumblr_blog_groups: tumblr_blog_groups,
      current_blog: current_blog,
      posts_count: posts_count,
      posts_limit: opts.limit,
      photo_posts_count: photo_posts_count,
      video_posts_count: video_posts_count,
      audio_posts_count: audio_posts_count,
      regular_posts_count: regular_posts_count,
      conversation_posts_count: conversation_posts_count,
      quote_posts_count: quote_posts_count,
      chat_posts_count: chat_posts_count,
      link_posts_count: link_posts_count,
      favorite_posts_count: favorite_posts_count,
      popular_reblogs: popular_reblogs,
      popular_blogs: popular_blogs,
      popular_years: popular_years,
      popular_tags: popular_tags,
      related_tags: [],
      bytes: bytes,
      moment: moment,
      ellipsisMiddle: ellipsisMiddle,
      trimText: utils.trimText
    }

    if (req.query.tag && tags_map[req.query.tag]) {
      var count = tags_map[req.query.tag].posts_count;
      var posts = tags_map[req.query.tag].posts.map(function(post_id) {
        return posts_map[post_id];        
      });

      if (req.session.sort && req.session.order) {
        sortItems(posts, req.session.sort, req.session.order);
      }
      
      var start_index = Math.min(opts.skip, posts.length);
      var end_index = Math.min(opts.skip + opts.limit, posts.length);
      posts = posts.slice(start_index, end_index);

      posts.forEach(function(post) {
        if (favorites_cache.get(post.id)) {
          post.favorited = true;
        }
      });

      var related_tags = [];
      if (tags_graph[req.query.tag]) {
        for (var rel_tag in tags_graph[req.query.tag]) {
          related_tags.push({
            name: rel_tag,
            posts_count: tags_graph[req.query.tag][rel_tag]
          });
        }
        related_tags.sort(function(a,b) {
          if (a.posts_count>b.posts_count) return -1;
          if (a.posts_count<b.posts_count) return 1;
          return 0;
        });
        var max_related_tags = Math.min(10, related_tags.length);
        if (related_tags.length > max_related_tags) {
          related_tags = related_tags.slice(0, max_related_tags);
        }
      }

      render_params.related_tags = related_tags;
      render_params.count = count;
      render_params.posts = posts;

      res.render('tumblr-browser', render_params);
    } else if (req.query.favorites) {
      var favorite_posts = [];
      for (var post_id in favorites_cache.toMap()) {
        favorite_posts.push(post_id);
      }
      var count = favorite_posts.length;
      var posts = favorite_posts.map(function(post_id) {
        return posts_map[post_id];
      });

      if (req.session.sort && req.session.order) {
        sortItems(posts, req.session.sort, req.session.order);
      }
      
      var start_index = Math.min(opts.skip, posts.length);
      var end_index = Math.min(opts.skip + opts.limit, posts.length);
      posts = posts.slice(start_index, end_index);

      posts.forEach(function(post) {
        post.favorited = true;
      });

      render_params.count = count;
      render_params.posts = posts;

      res.render('tumblr-browser', render_params);
    } else {
      getPostsCount(condition, function(err, count) {
        if (err) return res.status(500).send(err.message);

        getPosts(condition, opts, function(err, posts) {
          if (err) return res.status(500).send(err.message);

          // console.log('Posts:', posts.length);

          posts.forEach(function(post) {
            if (favorites_cache.get(post.id)) {
              post.favorited = true;
            }
          });

          render_params.count = count;
          render_params.posts = posts;
      
          res.render('tumblr-browser', render_params);
        });
      });
    }
  }
  
  var indexPage = function(req, res, next) {
    
    if (options.live) {
      return liveIndexPage(req, res, next);
    }

    if (req.query.load_blog) {
      if (req.query.load_blog == current_blog) {
        return res.redirect('/');
      }
      if (!tumblr_blogs_map[req.query.load_blog]) {
        return res.status(400).send('Unavailable blog: ' + req.query.load_blog);
      }
      return unloadTumblrData(tumblr_blogs_map[current_blog].data_dir, function(err) {
        current_blog = req.query.load_blog;
        loadTumblrData(tumblr_blogs_map[req.query.load_blog].data_dir, function(err) {
          if (err) {
            console.log('Tumblr not found: ' + req.query.load_blog);
            return res.status(404).send('Tumblr not found: ' + req.query.load_blog);
          }
          res.redirect('/');
        });
      });
    } else if (req.query.reload_blogs) {
      return reloadTumblrList(function(err) {
        if (err) return res.status(500).send('Reload blog list failed: ' + err.message);
        res.redirect('/');
      });
    } else {
      return displayArchivedPosts(req, res, next);
    }
  }

  var liveIndexPage = function(req, res, next) {

    if (req.query.load_blog) {
      current_blog = req.query.load_blog;
      return res.redirect('/');
    } else if (req.query.reload_blogs) {
      return reloadTumblrList(function(err) {
        if (err) return res.status(500).send('Reload blog list failed: ' + err.message);
        res.redirect('/');
      });
    } else if (req.query.blog || req.query.reblog || req.query.origin 
      || req.query.year || req.query.tag || req.query.q || req.query.favorites) {
      return displayArchivedPosts(req, res, next);
    }

    var opts = {};
    opts.num = req.query.limit ? parseInt(req.query.limit) : 50;
    opts.start = req.query.skip ? parseInt(req.query.skip) : 0;
    
    var sort_field = req.query.sort || req.session.sort || 'unix-timestamp';
    var sort_order = req.query.order || req.session.order || 'desc';
    opts.sort = {};
    if (sort_order == 'desc') {
      opts.sort[sort_field] = -1;
    } else {
      opts.sort[sort_field] = 1;
    }

    var query = req.query;
    if (req.query.sort && req.session.sort != req.query.sort) req.session.sort = req.query.sort;
    if (req.query.order && req.session.order != req.query.order) req.session.order = req.query.order;
    if (!req.query.sort) {
      query.sort = req.session.sort || sort_field;
      query.order = query.order || req.session.order || sort_order;
    }

    if (req.query.photos) opts.type = 'photo';
    if (req.query.videos) opts.type = 'video';
    if (req.query.regular) opts.type = 'regular';
    if (req.query.conversations) opts.type = 'conversation';
    if (req.query.chats) opts.type = 'chat';
    if (req.query.quotes) opts.type = 'quote';
    if (req.query.links) opts.type = 'link';
    if (req.query.audio) opts.type = 'audio';

    if (req.query.live_tag) {
      opts.tagged = req.query.live_tag;
    }

    // console.log(current_blog, opts);

    var tumblr_starred_blogs = tumblr_blogs.filter(function(blog) {
      return blog.starred;
    });
    var tumblr_unstarred_blogs = tumblr_blogs.filter(function(blog) {
      return !blog.starred;
    });

    var tumblr_blog_grouped = false;
    var tumblr_blog_groups = {};
    if (tumblr_blogs.length > 150) {
      tumblr_blog_grouped = true;
      var first_char = '';
      tumblr_blogs.forEach(function(blog) {
        if (blog.starred) return;
        first_char = blog.name[0].toUpperCase();
        if (!isNaN(parseInt(first_char))) first_char = '#';
        if (!tumblr_blog_groups[first_char]) tumblr_blog_groups[first_char] = [];
        tumblr_blog_groups[first_char].push(blog); 
      });
    }

    getLivePosts(current_blog, opts, function(err, result) {
      if (err) return res.status(500).send(err.message);

      var render_params = {
        query: query,
        features: features,
        is_live: options.live,
        live_posts: true,
        tumblr_blogs: tumblr_blogs,
        tumblr_starred_blogs: tumblr_starred_blogs,
        tumblr_unstarred_blogs: tumblr_unstarred_blogs,
        tumblr_blog_grouped: tumblr_blog_grouped,
        tumblr_blog_groups: tumblr_blog_groups,
        current_blog: current_blog,
        posts_count: posts_count,
        posts_limit: opts.num,
        photo_posts_count: photo_posts_count,
        video_posts_count: video_posts_count,
        audio_posts_count: audio_posts_count,
        regular_posts_count: regular_posts_count,
        conversation_posts_count: conversation_posts_count,
        quote_posts_count: quote_posts_count,
        chat_posts_count: chat_posts_count,
        link_posts_count: link_posts_count,
        favorite_posts_count: favorite_posts_count,
        popular_reblogs: popular_reblogs,
        popular_blogs: popular_blogs,
        popular_years: popular_years,
        popular_tags: popular_tags,
        related_tags: [],
        bytes: bytes,
        moment: moment,
        ellipsisMiddle: ellipsisMiddle,
        trimText: utils.trimText
      };

      if (result && result.posts) {
        var posts = result.posts.slice(0);
        posts.forEach(function(post) {
          if (favorites_cache.get(post.id)) {
            post.favorited = true;
          }
        });

        render_params.count = result['posts-total'];
        render_params.posts = result.posts;
    
        res.render('tumblr-browser', render_params);
      } else {
        render_params.count = 0;
        render_params.posts = [];
    
        res.render('tumblr-browser', render_params);
      }
    });
  }

  var allTagsPage = function(req, res) {

    var grouped_tags = {};
    var incrementTagCount = function(group, tag) {
      if (!grouped_tags[group]) {
        grouped_tags[group] = [];
      } 
      grouped_tags[group].push(tag);
    }
    all_tags.forEach(function(tag) {
      if (tag.posts_count > 5000) {
        incrementTagCount('More than 5000 posts', tag);
      } else if (tag.posts_count > 1000) {
        incrementTagCount('More than 1000 posts', tag);
      } else if (tag.posts_count > 500) {
        incrementTagCount('More than 500 posts', tag);
      } else if (tag.posts_count > 100) {
        incrementTagCount('More than 100 posts', tag);
      } else if (tag.posts_count > 50) {
        incrementTagCount('More than 50 posts', tag);
      } else if (tag.posts_count > 10) {
        incrementTagCount('More than 10 posts', tag);
      } else if (tag.posts_count > 5) {
        incrementTagCount('More than 5 posts', tag);
      } else {
        incrementTagCount('Less than 5 posts', tag);
      }
    });

    res.render('tumblr-tags', {
      query: req.query,
      all_tags: all_tags,
      grouped_tags: grouped_tags,
      popular_tags: popular_tags,
      blogs: tumblr_blogs,
      current_blog: current_blog,
      posts_count: posts_count,
      favorite_posts_count: favorite_posts_count,
      moment: moment,
      ellipsisMiddle: ellipsisMiddle
    });
  }

  var allReblogsPage = function(req, res) {

    var grouped_reblogs = {};
    var incrementReblogCount = function(group, reblog) {
      if (!grouped_reblogs[group]) {
        grouped_reblogs[group] = [];
      } 
      grouped_reblogs[group].push(reblog);
    }
    all_reblogs.forEach(function(reblog) {
      if (reblog.posts_count > 5000) {
        incrementReblogCount('More than 5000 posts', reblog);
      } else if (reblog.posts_count > 1000) {
        incrementReblogCount('More than 1000 posts', reblog);
      } else if (reblog.posts_count > 500) {
        incrementReblogCount('More than 500 posts', reblog);
      } else if (reblog.posts_count > 100) {
        incrementReblogCount('More than 100 posts', reblog);
      } else if (reblog.posts_count > 50) {
        incrementReblogCount('More than 50 posts', reblog);
      } else if (reblog.posts_count > 10) {
        incrementReblogCount('More than 10 posts', reblog);
      } else if (reblog.posts_count > 5) {
        incrementReblogCount('More than 5 posts', reblog);
      } else {
        incrementReblogCount('Less than 5 posts', reblog);
      }
    });

    res.render('tumblr-reblogs', {
      query: req.query,
      all_reblogs: all_reblogs,
      grouped_reblogs: grouped_reblogs,
      popular_reblogs: popular_reblogs,
      blogs: tumblr_blogs,
      current_blog: current_blog,
      posts_count: posts_count,
      favorite_posts_count: favorite_posts_count,
      moment: moment,
      ellipsisMiddle: ellipsisMiddle
    });
  }

  var openExternalFile = function(req, res) {
    var fpath = path.join(data_dir, req.query.path);
    open(fpath);
    return res.send('OK');
  }

  var getFile = function(req, res) {
    var filepath = path.join(data_dir, req.query.path);
    return res.sendFile(filepath);
  }

  var favoritePost = function(req, res) {
    if (!req.query.post_id) {
      return res.status(400).json({error: 'Missing post_id'});
    }

    if (!favorites_cache.get(req.query.post_id)) {
      favorites_cache.set(req.query.post_id, {faved_at: new Date()});
      favorite_posts_count++;
    }

    res.json({favorited: true});
  }

  var unfavoritePost = function(req, res) {
    if (!req.query.post_id) {
      return res.status(400).json({error: 'Missing post_id'});
    }

    if (favorites_cache.get(req.query.post_id)) {
      favorites_cache.delete(req.query.post_id);
      favorite_posts_count--;
    }

    res.json({unfavorited: true});
  }

  var getTumblrPhoto = function(req, res) {
    var output_dir = tumblr_blogs_map[current_blog].data_dir;

    var filename = path.basename(req.query.src);
    var filepath = path.join(output_dir, filename);
    
    if (utils.fileExists(path.join(output_dir, filename))) {
      // return res.sendFile(filepath);
      return res.redirect(path.relative(data_dir, filepath));
    }
    
    filepath = path.join(output_dir, 'photos', filename);
    if (utils.fileExists(filepath)) {
      // return res.sendFile(filepath);
      return res.redirect(path.relative(data_dir, filepath));
    }

    // console.log('Photo not exist:', filepath);
    if (options.redirect_photo && !options.cache_photo) {
      return res.redirect(req.query.src);
    }

    download_photo_queue.pushJob({
      image_src: req.query.src,
      image_file: filepath
    }, function(args, done) {
      if (utils.fileExists(args.image_file)) {
        return done();
      }
      console.log('Download photo:', args.image_src);
      downloader.downloadFile(args.image_src, args.image_file, function(err, result) {
        return done(err);
      });
    }, function(err) {
      if (err) {
        console.log(err);
        res.writeHead(404);
        res.end();
      } else {
        // res.sendFile(filepath);
        return res.redirect(path.relative(data_dir, filepath));
      }
    });
  }

  var downloadPost = function(req, res) {
    if (options.no_download) {
      return res.status(403).json({error: 'This feature is not available.'});
    }
    if (!req.query.post_id) {
      return res.status(400).json({error: 'Missing post_id'});
    }
    // get post info
    getPostInfo(req.query.post_id, function(err, post) {
      if (err) return res.status(500).json({error: err.message});
      if (!post) return res.status(404).json({error: 'Post not found'});

      console.log('Download post:', post.id, '-', post.url);

      var photos = post.photos.slice();
      if (post.photos.length == 0) {
        photos.push({
          'photo-url-1280': post.photo_url_large,
          'photo-url-500': post.photo_url_medium,
        });
      }

      var downloaded_photos_count = 0;
      var output_dir = tumblr_blogs_map[current_blog].data_dir;

      // download the post photos
      async.eachSeries(photos, function(photo, cb) {
        var photo_src = photo['photo-url-1280'] || photo['photo-url-500'];
        if (!photo_src) return cb();

        if (utils.fileExists(path.join(output_dir, path.basename(photo_src)))) {
          downloaded_photos_count++;
          return cb();
        }
        var photo_file = path.join(output_dir, 'photos', path.basename(photo_src));
        if (utils.fileExists(photo_file)) {
          downloaded_photos_count++;
          return cb();
        }

        console.log('Download photo:', photo_src);
        downloader.downloadFile(photo_src, photo_file, function(err, result) {
          return cb(err);
        });
      }, function(err) {
        if (err) return res.status(500).json({error: err.message});

        res.json({downloaded: true, downloaded_photos_count: downloaded_photos_count});
      });
    });
  }

  var addDownloadPostJob = function(args) {
    download_post_queue.pushJob(args, function(args, done) {
      console.log('Download posts from:', args.output_dir);

      var download_args = [args.output_dir];
      if (args.tag) {
        console.log('Tag:', args.tag);
        download_args.push('--tag');
        download_args.push(args.tag);
      }
      if (args.reblog) {
        console.log('Reblog:', args.reblog);
        download_args.push('--reblog');
        download_args.push(args.reblog);
      }
      if (args.origin) {
        console.log('Origin:', args.origin);
        download_args.push('--origin');
        download_args.push(args.origin);
      }
      if (args.selected_posts && args.selected_posts_file) {
        console.log('Selected posts:', args.selected_posts_file);
        download_args.push('--selected-posts-file');
        download_args.push(args.selected_posts_file);
      }

      executeCommand('tumblr-download-posts', download_args, {verbose: true}, function(err) {
        if (args.selected_posts_file && utils.fileExists(args.selected_posts_file)) {
          fse.removeSync(args.selected_posts_file);
        }
        if (err) {
          if (io) {
            io.emit('download-finished', {
              error: err.message,
              tag: args.tag,
              reblog: args.reblog,
              origin: args.origin,
              selected_posts_file: args.selected_posts_file
            });
          }
          console.log(err);
          return done(err);
        }
        if (io) {
          io.emit('download-finished', { 
            tag: args.tag, 
            reblog: args.reblog,
            origin: args.origin,
            selected_posts_file: args.selected_posts_file
          });
        }
        return done();
      });
    }, function(err) {
      if (err) {
        console.log(err);
      }
    });
  }

  var downloadPosts = function(req, res) {
    if (options.no_download) {
      return res.status(403).json({error: 'This feature is not available.'});
    }

    var tag = req.query.tag || req.body.tag;
    var reblog = req.query.reblog || req.body.reblog;
    var origin = req.query.origin || req.body.origin;
    var query = req.query.q || req.body.q;

    // if (!tag && !reblog && !origin && !query) {
    //   return res.status(400).json({error: 'Missing both tag, reblog, origin and q'});
    // }

    var output_dir = tumblr_blogs_map[current_blog].data_dir;
    if (tag || reblog || origin) {
      addDownloadPostJob({
        tag: tag,
        reblog: reblog,
        origin: origin,
        output_dir: output_dir
      });

      if (tag) console.log('Download posts - with tag:', tag, 
        '(queued: ' + download_post_queue.jobCount() + ')');
      else if (reblog) console.log('Download posts - with reblog:', reblog, 
        '(queued: ' + download_post_queue.jobCount() + ')');
      else if (origin) console.log('Download posts - with origin:', origin, 
        '(queued: ' + download_post_queue.jobCount() + ')');

      return res.json({queued: true});
    } else if (query) {
      var condition = {};
      condition = buildSearchCondition(query, 'slug');

      getPostsCount(condition, function(err, count) {
        if (err) return res.status(500).send(err.message);

        console.log('Matched posts:', count);

        posts_store.find(condition, {_id: 1, id: 1, url: 1, slug: 1}, function(err, posts) {
          if (err) return res.status(500).send(err.message);
          if (!posts) return res.status(500).send('Get posts failed!');

          if (posts.length == 0) {
            return res.json({});
          }

          var selected_posts_info = {};
          posts.forEach(function(post) {
            selected_posts_info[post.id] = {
              url: post.url,
              slug: post.slug,
              selected_at: new Date()
            };
          });

          var selected_posts_file = path.join(output_dir, 'download-selected-posts-' + 
            (new Date()).getTime() + '.json');
          utils.saveToJsonFile(selected_posts_info, selected_posts_file);

          addDownloadPostJob({
            selected_posts: true,
            selected_posts_file: selected_posts_file,
            output_dir: output_dir
          });

          console.log('Download posts - with query:', query, 
            '(queued: ' + download_post_queue.jobCount() + ')');

          return res.json({queued: true});
        });
      });
    } else {
      addDownloadPostJob({
        output_dir: output_dir
      });

      console.log('Download all posts', '(queued: ' + download_post_queue.jobCount() + ')');

      return res.json({queued: true});
    }
  }

  var getPost = function(req, res) {
    if (!req.query.post_id) {
      return res.status(400).json({error: 'Missing post_id'});
    }
    getPostInfo(req.query.post_id, function(err, post) {
      if (err) return res.status(500).json({error: err.message});
      if (!post) return res.status(404).json({error: 'Post not found'});
      
      res.json(post);
    });
  }

  var addBlog = function(req, res) {
    var blog = req.query.blog || req.body.blog;
    if (!blog) {
      return res.status(400).json({error: 'Missing blog'});
    }
    blog = blog.trim();

    scraping_queue.pushJob({
      blog: blog
    }, function(args, done) {
      var tumblr_url = 'https://'+args.blog+'.tumblr.com';
      var archive_args = [tumblr_url, data_dir, '--simple-log'];
      archive_args.push('--max-posts=' + 50000);

      executeCommand('tumblr-archive', archive_args, {verbose: true}, function(err) {
        if (err) {
          if (io) {
            io.emit('scrape-finished', {
              error: err.message,
              blog: args.blog
            });
          }
          console.log(err);
          return done(err);
        }
        if (io) io.emit('scrape-finished', { blog: args.blog });
        return done();
      });
    }, function(err) {
      if (err) {
        console.log(err);
      } else {
        if (utils.directoryExists(path.join(data_dir, blog)) 
          && utils.fileExists(path.join(data_dir, blog, 'tumblr-posts.db'))) {
          if (!tumblr_blogs_map[blog]) {
            tumblr_blogs_map[blog] = {
              url: 'https://' + blog + '.tumblr.com',
              name: blog,
              data_dir: path.join(data_dir, blog),
              archived: true
            }
            tumblr_blogs.push(tumblr_blogs_map[blog]);
          } else {
            tumblr_blogs_map[blog].archived = true;
          }
        }
      }
    });

    console.log('Add blog:', blog, 'queued: ' + scraping_queue.jobCount());
    res.json({queued: true});
  }

  var starBlog = function(req, res) {
    if (!req.query.blog) {
      return res.status(400).json({error: 'Missing blog'});
    }

    var blog_name = req.query.blog;

    if (!tumblr_blogs_map[blog_name]) {
      return res.status(400).json({error: 'Blog not found'});
    }
    if (tumblr_blogs_map[blog_name].starred) {
      return res.json({starred: true});
    }

    tumblr_blogs_map[blog_name].starred = true;
    for (var i = 0; i < tumblr_blogs.length; i++) {
      var blog = tumblr_blogs[i];
      if (blog.name == blog_name) {
        blog.starred = true;
      }
    }

    var starred_blogs_info = {};
    if (utils.fileExists(path.join(data_dir, 'tumblr-stars.json'))) {
      starred_blogs_info = utils.loadFromJsonFile(path.join(data_dir, 'tumblr-stars.json'));
    }

    if (starred_blogs_info[blog_name]) {
      return res.json({starred: true});
    }

    starred_blogs_info[blog_name] = {
      starred_at: new Date()
    };
    
    utils.saveToJsonFile(starred_blogs_info, path.join(data_dir, 'tumblr-stars.json'));

    return res.json({starred: true});
  }

  var unstarBlog = function(req, res) {
    if (!req.query.blog) {
      return res.status(400).json({error: 'Missing blog'});
    }

    var blog_name = req.query.blog;

    if (!tumblr_blogs_map[blog_name]) {
      return res.status(400).json({error: 'Blog not found'});
    }
    if (!tumblr_blogs_map[blog_name].starred) {
      return res.json({unstarred: true});
    }

    tumblr_blogs_map[blog_name].starred = false;
    for (var i = 0; i < tumblr_blogs.length; i++) {
      var blog = tumblr_blogs[i];
      if (blog.name == blog_name) {
        blog.starred = false;
      }
    }

    var starred_blogs_info = {};
    if (utils.fileExists(path.join(data_dir, 'tumblr-stars.json'))) {
      starred_blogs_info = utils.loadFromJsonFile(path.join(data_dir, 'tumblr-stars.json'));
    }

    if (!starred_blogs_info[blog_name]) {
      return res.json({starred: true});
    }

    delete starred_blogs_info[blog_name];
    
    utils.saveToJsonFile(starred_blogs_info, path.join(data_dir, 'tumblr-stars.json'));

    return res.json({starred: true});
  }

  // GET /
  // GET /?q=...
  // GET /?photos=1
  // GET /?videos=1
  // GET /?load_blog=...
  // GET /?reblog=...
  // GET /?origin=...
  // GET /?blog=...
  // GET /?year=...
  // GET /?tag=...
  // GET /?limit=...&skip=...&sort=...
  app.get('/', auth, indexPage);

  // GET /all-tags
  app.get('/all-tags', allTagsPage);

  // GET /all-reblogs
  app.get('/all-reblogs', allReblogsPage);

  // GET /open?path=...
  app.get('/open', auth, openExternalFile);

  // GET /file?path=...
  app.get('/file', auth, getFile);

  // GET /favorite?post_id=...
  app.post('/favorite', auth, favoritePost);

  // GET /unfavorite?post_id=...
  app.post('/unfavorite', auth, unfavoritePost);

  // GET /tumblr_photo?src=...
  app.get('/tumblr_photo', getTumblrPhoto);
  app.get('/tumblr_photo/:photo_file', getTumblrPhoto);

  // POST /download_post?post_id=...
  app.post('/download_post', downloadPost);

  // POST /download_posts?tag=...
  // POST /download_posts?reblog=...
  // POST /download_posts?origin=...
  // POST /download_posts?q=...
  app.post('/download_posts', downloadPosts);

  // GET /post?post_id=...
  app.get('/post', getPost);

  // POST /add_blog?blog=...
  app.post('/add_blog', addBlog);

  // GET /star?blog=...
  app.post('/star', auth, starBlog);

  // GET /unstar?blog=...
  app.post('/unstar', auth, unstarBlog);

  //// Caching

  var getCachedImagePath = function(image_src) {
    var url_obj = urlutil.parse(image_src);
    var url_hostname = (url_obj) ? url_obj.hostname : '';
    var cached_image_path = '';
    if (!url_hostname || url_hostname == '') {
      cached_image_path = path.join('images', 'nohost', url_obj.pathname);
    } else {
      cached_image_path = path.join('images', url_hostname, url_obj.pathname);
    }
    return cached_image_path;
  }

  var getCachedImage = function (req, res, next) {
    if (typeof req.query.src == 'undefined') {
      res.writeHead(400); // Bad Request
      res.end();
      return;
    }

    var image_src = req.query.src;
    if (image_src.indexOf('//') == 0) {
      image_src = 'http:' + image_src;
    }

    if (options.no_cache || options.redirect_photo) {
      return res.redirect(image_src);
    }

    // console.log(image_src);
    var cached_image_path = getCachedImagePath(image_src);
    var cached_image_abs_path = path.join(cache_dir, cached_image_path);

    download_photo_queue.pushJob({
      image_src: image_src,
      image_file: cached_image_abs_path
    }, function(args, done) {
      // console.log(args.image_file);
      if (utils.fileExists(args.image_file)) {
        return done();
      }
      downloader.downloadFile(args.image_src, args.image_file, function(err, result) {
        return done(err);
      });
    }, function(err) {
      if (err) {
        res.writeHead(404);
        res.end();
      } else {
        res.redirect(cached_image_path);
      }
    });
  }

  // GET /image?src=...
  app.get('/image', auth, getCachedImage);

  //// End of Caching

  var http = require('http').Server(app);
  io = require('socket.io')(http);
  io.on('connection', function(socket) {
    if (is_scraping) socket.emit('scraping');
  });

  var startListen = function(callback) {
    http.listen(listen_port, function () {
      console.log('Listening on http://localhost:'+listen_port);
      if (!options.no_open) open('http://localhost:'+listen_port);

      server_started = true;
      callback();
    }).on('error', function(err) {
      if (err.code == 'EADDRINUSE') {
        setTimeout(function() {
          listen_port = listen_port + 1;
          startListen(callback);
        });
      } else {
        console.log(err);
        callback(err);
      }
    });
  }

  startListen(done);
}

var sortByPostsCount = function(array) {
  array.sort(function(a,b) {
    if (a.posts_count > b.posts_count) return -1;
    if (a.posts_count < b.posts_count) return 1;
    return 0;
  })
}

function updatePostsIndex(posts) {
  posts.forEach(function(post) {
    if (post.type == 'photo') photo_posts_count++;
    else if (post.type == 'video') video_posts_count++;
    else if (post.type == 'audio') audio_posts_count++;
    else if (post.type == 'regular') regular_posts_count++;
    else if (post.type == 'conversation') conversation_posts_count++;
    else if (post.type == 'quote') quote_posts_count++;
    else if (post.type == 'chat') chat_posts_count++;
    else if (post.type == 'link') link_posts_count++;

    if (post.tumblelog && post.tumblelog.name) {
      var blog_name = post.tumblelog.name;
      if (blogs_map[blog_name]) blogs_map[blog_name] += 1;
      else blogs_map[blog_name] = 1;
    }
    if (post['reblogged-from-name']) {
      var reblog_from = post['reblogged-from-name'];
      if (reblogs_map[reblog_from]) reblogs_map[reblog_from] += 1;
      else reblogs_map[reblog_from] = 1;
    }
    if (post['unix-timestamp']) {
      var post_created = new Date(post['unix-timestamp']*1000);
      var post_year = post_created.getFullYear();
      if (years_map[post_year]) years_map[post_year] += 1;
      else years_map[post_year] = 1;
    }
    if (post.tags && post.tags.length) {
      // post_tags_map[post.id] = post.tags;
      post.tags.forEach(function(tag) {
        if (tags_map[tag]) {
          tags_map[tag].posts.push(post.id);
          tags_map[tag].posts_count += 1;
        } else {
          tags_map[tag] = {};
          tags_map[tag].posts = [];
          tags_map[tag].posts.push(post.id);
          tags_map[tag].posts_count = 1;
        }
        if (!tags_graph[tag]) tags_graph[tag] = {};
        for (var i = 0; i < post.tags.length; i++) {
          if (post.tags[i] != tag) {
            var rel_tag = post.tags[i];
            if (!tags_graph[tag][rel_tag]) tags_graph[tag][rel_tag] = 0;
            tags_graph[tag][rel_tag]++;
          }
        }
      });
    }
    posts_map[post.id] = post;
  });

  all_blogs = [];
  for (var blog_name in blogs_map) {
    all_blogs.push({name: blog_name, posts_count: blogs_map[blog_name]});
  }
  sortByPostsCount(all_blogs);
  if (all_blogs.length > 20) popular_blogs = all_blogs.slice(0, 20);
  else popular_blogs = all_blogs.slice();

  all_reblogs = [];
  for (var reblog_name in reblogs_map) {
    all_reblogs.push({name: reblog_name, posts_count: reblogs_map[reblog_name]});
  }
  sortByPostsCount(all_reblogs);
  if (all_reblogs.length > 20) popular_reblogs = all_reblogs.slice(0, 20);
  else popular_reblogs = all_reblogs.slice();

  all_years = [];
  for (var year in years_map) {
    all_years.push({name: year, posts_count: years_map[year]});
  }
  sortByPostsCount(all_years);
  if (all_years.length > 20) popular_years = all_years.slice(0, 20);
  else popular_years = all_years.slice();

  all_tags = [];
  for (var tag_name in tags_map) {
    all_tags.push({name: tag_name, posts_count: tags_map[tag_name].posts_count});
  }
  sortByPostsCount(all_tags);
  if (all_tags.length > 50) popular_tags = all_tags.slice(0, 50);
  else popular_tags = all_tags.slice();
}

function indexPosts(done) {

  posts_count = 0;
  favorite_posts_count = 0;

  blogs_map = {};
  reblogs_map = {};

  posts_map = {};
  tags_map = {};
  tags_graph = {};

  all_blogs = [];
  all_tags = [];
  all_reblogs = [];
  all_years = [];

  popular_blogs = [];
  popular_reblogs = [];
  popular_tags = [];
  popular_years = [];

  console.log('Indexing posts...');
  posts_store.find({}, function(err, posts) {
    if (err) {
      console.log(err);
      return done(err);
    }
    
    posts_count = posts.length;
    console.log('Posts:', posts_count);

    posts.forEach(function(post) {
      if (post.type == 'photo') photo_posts_count++;
      else if (post.type == 'video') video_posts_count++;
      else if (post.type == 'audio') audio_posts_count++;
      else if (post.type == 'regular') regular_posts_count++;
      else if (post.type == 'conversation') conversation_posts_count++;
      else if (post.type == 'quote') quote_posts_count++;
      else if (post.type == 'chat') chat_posts_count++;
      else if (post.type == 'link') link_posts_count++;

      if (post.tumblelog && post.tumblelog.name) {
        var blog_name = post.tumblelog.name;
        if (blogs_map[blog_name]) blogs_map[blog_name] += 1;
        else blogs_map[blog_name] = 1;
      }
      if (post['reblogged-from-name']) {
        var reblog_from = post['reblogged-from-name'];
        if (reblogs_map[reblog_from]) reblogs_map[reblog_from] += 1;
        else reblogs_map[reblog_from] = 1;
      }
      if (post['unix-timestamp']) {
        var post_created = new Date(post['unix-timestamp']*1000);
        var post_year = post_created.getFullYear();
        if (years_map[post_year]) years_map[post_year] += 1;
        else years_map[post_year] = 1;
      }
      if (post.tags && post.tags.length) {
        post.tags.forEach(function(tag) {
          if (tags_map[tag]) {
            tags_map[tag].posts.push(post.id);
            tags_map[tag].posts_count += 1;
          } else {
            tags_map[tag] = {};
            tags_map[tag].posts = [];
            tags_map[tag].posts.push(post.id);
            tags_map[tag].posts_count = 1;
          }
          if (!tags_graph[tag]) tags_graph[tag] = {};
          for (var i = 0; i < post.tags.length; i++) {
            if (post.tags[i] != tag) {
              var rel_tag = post.tags[i];
              if (!tags_graph[tag][rel_tag]) tags_graph[tag][rel_tag] = 0;
              tags_graph[tag][rel_tag]++;
            }
          }
        });
      }
      posts_map[post.id] = post;
    });

    for (var post_id in favorites_cache.toMap()) {
      favorite_posts_count++;
    }
    console.log('Favorite Posts:', favorite_posts_count);

    for (var blog_name in blogs_map) {
      all_blogs.push({name: blog_name, posts_count: blogs_map[blog_name]});
    }
    console.log('Blogs:', all_blogs.length);
    sortByPostsCount(all_blogs);
    if (all_blogs.length > 20) popular_blogs = all_blogs.slice(0, 20);
    else popular_blogs = all_blogs.slice();

    for (var reblog_name in reblogs_map) {
      all_reblogs.push({name: reblog_name, posts_count: reblogs_map[reblog_name]});
    }
    console.log('Reblogs:', all_reblogs.length);
    sortByPostsCount(all_reblogs);
    if (all_reblogs.length > 20) popular_reblogs = all_reblogs.slice(0, 20);
    else popular_reblogs = all_reblogs.slice();

    for (var year in years_map) {
      all_years.push({name: year, posts_count: years_map[year]});
    }
    console.log('Years:', all_years.length);
    sortByPostsCount(all_years);
    if (all_years.length > 20) popular_years = all_years.slice(0, 20);
    else popular_years = all_years.slice();

    for (var tag_name in tags_map) {
      all_tags.push({name: tag_name, posts_count: tags_map[tag_name].posts_count});
    }
    console.log('Tags:', all_tags.length);
    sortByPostsCount(all_tags);
    if (all_tags.length > 50) popular_tags = all_tags.slice(0, 50);
    else popular_tags = all_tags.slice();

    // utils.saveToJsonFile(tags_graph, path.join(blog_dir, 'tumblr-tags-graph.json'));

    if (options.live) updateTumblrListFromPosts(posts);

    console.log('Indexing posts... Done.');
    done();
  });
}

var createBrowsePostsDB = function(blog_dir, done) {
  if (!options.live && !utils.fileExists(path.join(blog_dir, 'tumblr-posts.db'))) {
    return done(new Error('Missing tumblr-posts.db'));
  }

  lockFile.lock(path.join(blog_dir, 'tumblr.lock'), {}, function (err) {
    if (err) {
      return done(err);
    }

    if (options.live) {
      lockFile.unlock(path.join(blog_dir, 'tumblr.lock'), function (err) {
        if (err) {
          return done(err);
        }

        return done();
      });
    } else {
      var posts_file = path.join(blog_dir, 'tumblr-posts.db');
      var posts_browse_file = path.join(blog_dir, 'tumblr-posts-browse.db');

      fse.copy(posts_file, posts_browse_file, {overwrite: true}, function(err) {
        if (err) {
          return done(err);
        }

        lockFile.unlock(path.join(blog_dir, 'tumblr.lock'), function (err) {
          if (err) {
            return done(err);
          }

          return done();
        });
      });
    }
  });
}

// var liveBrowseBlog = function(blog_dir, posts_store, done) {
//   if (tumblr_scraper) {
//     tumblr_scraper.destroy();
//     tumblr_scraper = null;
//   }

//   // create new scraper
//   tumblr_scraper = new TumblrScraper({
//     output_dir: blog_dir,
//     posts_store: posts_store
//   });

//   tumblr_scraper.on('progress', function(data) {
//     if (io) io.emit('scraping-progress', data);
//   });

//   scraping_queue.pushJob({blog: current_blog}, function(args, done) {
//     // update data from blog
//     console.log('Update data from blog:', args.blog);
//     is_scraping = true;
//     tumblr_scraper.scrapeBlog(args.blog, {stop_if_no_new_posts: true}, done);
//   }, function(err) {
//     is_scraping = false;
//     if (err) {
//       console.log(err);
//     } else {
//       var stats = tumblr_scraper.getStats();
//       if (stats && stats.new_posts_count) {
//         indexPosts(function(err) {
//           if (err) {
//             console.log(err);
//           }
//           if (io) io.emit('scraping-done', {new_posts_count: stats.new_posts_count});
//         });
//       } else {
//         if (io) io.emit('scraping-done', {new_posts_count: 0});
//       }
//     }
//   });

//   indexPosts(function(err) {
//     if (err) {
//       console.log(err);
//       return done(err);
//     }
//     startServer(done);
//   });
// }

var loadTumblrData = function(blog_dir, done) {
  console.log('Load blog data:', blog_dir);

  fse.ensureDirSync(blog_dir);

  createBrowsePostsDB(blog_dir, function (err) {
    if (err) {
      console.log(err);
      return done(err);
    }

    lockFile.lock(path.join(blog_dir, 'tumblr-browse.lock'), {}, function (err) {
      if (err) {
        console.log(err);
        return done(err);
      }

      if (!options.live && !utils.fileExists(path.join(blog_dir, 'tumblr-posts-browse.db'))) {
        console.log('Missing tumblr-posts-browse.db');
        return done(new Error('Missing tumblr-posts-browse.db'));
      }

      favorites_cache = new JsonStore({
        file: path.join(blog_dir, 'tumblr-favorites.json')
      });

      posts_store = new NeDB({
        filename: path.join(blog_dir, 'tumblr-posts-browse.db'),
        autoload: true
      });

      indexPosts(function(err) {
        if (err) {
          console.log(err);
          return done(err);
        }
        startServer(done);
      });
    });
  });
}

var unloadTumblrData = function(blog_dir, done) {
  lockFile.unlock(path.join(blog_dir, 'tumblr-browse.lock'), function (err) {
    if (err) {
      console.log(err);
    }

    if (favorites_cache) favorites_cache.exit();

    posts_count = 0;
    photo_posts_count = 0;
    video_posts_count = 0;
    regular_posts_count = 0;
    conversation_posts_count = 0;
    quote_posts_count = 0;
    chat_posts_count = 0;
    link_posts_count = 0;
    audio_posts_count = 0;
    favorite_posts_count = 0;

    latest_created = 0;
    oldest_created = 0;

    reblogs_map = {};
    blogs_map = {};
    years_map = {};

    posts_map = {};
    // post_tags_map = {};
    tags_map = {};
    tags_graph = {};

    all_tags = [];
    all_reblogs = [];
    all_blogs = [];
    all_years = [];

    popular_tags = [];
    popular_reblogs = [];
    popular_blogs = [];
    popular_years = [];

    return done();
  });
}

var loadTumblrList = function(done) {

  if (options.blogs_file && utils.fileExists(options.blogs_file)) {
    console.log('Blogs file:', options.blogs_file);

    var blogs_info = utils.loadFromJsonFile(options.blogs_file);
    for (var source_url in blogs_info) {
      var blog_name = getBlogName(source_url);

      if (!tumblr_blogs_map[blog_name]) {
        tumblr_blogs_map[blog_name] = {
          url: source_url, 
          name: blog_name,
          nsfw: blogs_info[source_url].nsfw,
          config: blogs_info[source_url]
        }
        if (blogs_info[source_url].output_dir) {
          tumblr_blogs_map[blog_name].data_dir = path.join(data_dir, blogs_info[source_url].output_dir);
        } else {
          tumblr_blogs_map[blog_name].data_dir = path.join(data_dir, 'blogs', blog_name);
        }
        tumblr_blogs_map[blog_name].archived = 
          utils.fileExists(path.join(tumblr_blogs_map[blog_name].data_dir, 'tumblr-posts.db'));
      }
    }
  } else if (utils.fileExists(path.join(data_dir, 'tumblr-sources.json'))) {
    var sources_info = utils.loadFromJsonFile(path.join(data_dir, 'tumblr-sources.json'));

    var is_data_dir_archived = utils.fileExists(path.join(data_dir, 'tumblr-posts.db'));
    for (var source_url in sources_info) {
      var blog_name = getBlogName(source_url);

      if (!tumblr_blogs_map[blog_name]) {
        tumblr_blogs_map[blog_name] = {
          url: source_url, 
          name: blog_name,
          config: sources_info[source_url],
          data_dir: data_dir
        }
        tumblr_blogs_map[blog_name].archived = 
          utils.fileExists(path.join(data_dir, 'blogs', blog_name, 'tumblr-posts.db'));
      }
    }
  }
  if (options.recursive && utils.directoryExists(path.join(data_dir, 'blogs'))) {
    var files = fs.readdirSync(path.join(data_dir, 'blogs'));

    for (var i = 0; i < files.length; i++) {
      var tumblr_config_file = path.join(data_dir, 'blogs', files[i], 'tumblr-sources.json');

      if (utils.fileExists(tumblr_config_file)) {
        var tumblr_info = utils.loadFromJsonFile(tumblr_config_file) || {};
        for (var tumblr_url in tumblr_info) {
          var blog_name = getBlogName(tumblr_url);

          if (!tumblr_blogs_map[blog_name]) {
            tumblr_blogs_map[blog_name] = {
              url: tumblr_url, 
              name: blog_name,
              config: tumblr_info[tumblr_url],
              data_dir: path.join(data_dir, 'blogs', files[i])
            }
            tumblr_blogs_map[blog_name].archived = 
              utils.fileExists(path.join(data_dir, 'blogs', files[i], 'tumblr-posts.db'));
          }
        }
      }
    }
  }

  if (utils.fileExists(path.join(data_dir, 'tumblr-stars.json'))) {
    var starred_blogs_info = utils.loadFromJsonFile(path.join(data_dir, 'tumblr-stars.json'));
    for (var blog_name in starred_blogs_info) {
      if (tumblr_blogs_map[blog_name]) {
        tumblr_blogs_map[blog_name].starred = true;
      }
    }
  }
  
  for (var blog_name in tumblr_blogs_map) {
    tumblr_blogs.push(tumblr_blogs_map[blog_name]);
  }

  console.log('Blogs:', tumblr_blogs.length);

  if (!options.live) {
    tumblr_blogs = tumblr_blogs.filter(function(blog) {
      // console.log('Tumblr:', blog.name);
      // return utils.fileExists(path.join(data_dir, 'blogs', blog.name, 'tumblr-posts.db'));
      // return utils.fileExists(path.join(blog.data_dir, 'tumblr-posts.db'));
      return blog.archived;
    });
    console.log('Available Blogs:', tumblr_blogs.length);
  }

  tumblr_blogs.sort(function(a,b) {
    if (a.name.toLowerCase() > b.name.toLowerCase()) return 1;
    else if (a.name.toLowerCase() < b.name.toLowerCase()) return -1;
    return 0;
  });

  return done();
}

var reloadTumblrList = function(done) {
  tumblr_blogs = [];
  return loadTumblrList(done);
}

var updateTumblrListFromPosts = function(posts) {
  var new_blogs_count = 0;

  posts.forEach(function(post) {
    if (post.tumblelog && post.tumblelog.name) {
      var blog_name = post.tumblelog.name;
      if (!tumblr_blogs_map[blog_name]) {
        new_blogs_count++;
        tumblr_blogs_map[blog_name] = {
          url: 'https://'+blog_name+'.tumblr.com',
          name: blog_name,
          data_dir: data_dir
        }
        tumblr_blogs.push(tumblr_blogs_map[blog_name]);
        tumblr_blogs_map[blog_name].archived = 
          utils.fileExists(path.join(data_dir, 'blogs', blog_name, 'tumblr-posts.db'));
      }
    }
    if (post['reblogged-from-name']) {
      var reblog_from = post['reblogged-from-name'];
      if (!tumblr_blogs_map[reblog_from]) {
        new_blogs_count++;
        tumblr_blogs_map[reblog_from] = {
          url: 'https://'+reblog_from+'.tumblr.com',
          name: reblog_from,
          data_dir: data_dir
        }
        tumblr_blogs.push(tumblr_blogs_map[reblog_from]);
        tumblr_blogs_map[blog_name].archived = 
          utils.fileExists(path.join(data_dir, 'blogs', blog_name, 'tumblr-posts.db'));
      }
    }
    if (post['reblogged-root-name']) {
      var origin_from = post['reblogged-root-name'];
      if (!tumblr_blogs_map[origin_from]) {
        new_blogs_count++;
        tumblr_blogs_map[origin_from] = {
          url: 'https://'+origin_from+'.tumblr.com',
          name: origin_from,
          data_dir: data_dir
        }
        tumblr_blogs.push(tumblr_blogs_map[origin_from]);
        tumblr_blogs_map[blog_name].archived = 
          utils.fileExists(path.join(data_dir, 'blogs', blog_name, 'tumblr-posts.db'));
      }
    }
  });

  if (new_blogs_count) {
    tumblr_blogs.sort(function(a,b) {
      if (a.name.toLowerCase() > b.name.toLowerCase()) return 1;
      else if (a.name.toLowerCase() < b.name.toLowerCase()) return -1;
      return 0;
    });

    // var tumblr_collected_blogs_info = {};
    // tumblr_blogs.forEach(function(blog) {
    //   tumblr_collected_blogs_info[blog.name] = {
    //     output_dir: path.relative(data_dir, blog.data_dir) || '.'
    //   }
    // });
    // utils.saveToJsonFile(tumblr_collected_blogs_info, path.join(data_dir, 'tumblr-collected-blogs.json'));
  }
}

loadTumblrList(function() {  
  if (tumblr_blogs.length == 0) {
    process.exit(0);
  }

  if (options.live) {
    current_blog = tumblr_blogs[0].name;
    loadTumblrData(data_dir, function(err) {
      if (err) {
        process.exit(1);
      }
    });
  } else {
    current_blog = tumblr_blogs[0].name;
    loadTumblrData(tumblr_blogs[0].data_dir, function(err) {
      if (err) {
        process.exit(1);
      }
    });
  }
});
