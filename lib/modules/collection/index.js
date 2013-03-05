var validation = require('validation')
  , util = require('util')
  , fs = require('fs')
  , path = require('path')
  , Resource = require('../../resource')
  , db = require('../../db')
  , EventEmitter = require('events').EventEmitter
  , debug = require('debug')('collection')
  , path = require('path')
  , Script = require('../../script');

/**
 * A `Collection` validates incoming requests then proxies them into a `Store`.
 *
 * Options:
 *
 *   - `path`                the base path a resource should handle
 *   - `config.properties`   the properties of objects the collection should store 
 *   - `db`                  the database a collection will use for persistence
 *
 * @param {Object} options
 */

function Collection(name, options) {
  Resource.apply(this, arguments);
  var config = this.config;
  if(config) {
    this.properties = config.properties;
  }
  if (options) {
    this.store = options.db && options.db.createStore(this.name);  
  }
  
  this.defaultPermissions = {
    'querying multiple objects': true,
    'querying an object by id': true,
    'creating an object': true,
    'deleting an object by id': true,
    'updating an object by id': true
  };  
}

util.inherits(Collection, Resource);
Collection.prototype.external = {};
Collection.prototype.clientGeneration = true;
Collection.events  = ['Get', 'Validate', 'Post', 'Put', 'Delete', 'Query', 'Request'];

Collection.prototype.eventNames  = ['Get', 'Validate', 'Post', 'Put', 'Delete'];
Collection.prototype.dashboard = {
    path: path.join(__dirname, 'dashboard')
  , pages: ['Properties', 'Data', 'Events', 'API']
  , scripts: [
      '/js/lib/jquery-ui-1.8.22.custom.min.js'
    , '/js/lib/knockout-2.1.0.js'
    , '/js/lib/knockout.mapping.js'
    , '/js/util/knockout-util.js'
    , '/js/util/key-constants.js'
    , '/js/util.js'
  ]
};

/**
 * Validate the request `body` against the `Collection` `properties` 
 * and return an object containing any `errors`.
 *
 * @param {Object} body
 * @return {Object} errors
 */

Collection.prototype.validate = function (body, create) {
  if(!this.properties) this.properties = {};
  
  var keys = Object.keys(this.properties)
    , props = this.properties
    , errors = {};
    
  keys.forEach(function (key) {
    var prop = props[key]
      , val = body[key]
      , type = prop.type || 'string';
    
    debug('validating %s against %j', key, prop);

    if(validation.exists(val)) {
      // coercion
      if(type === 'number') val = Number(val);

      if(!validation.isType(val, type)) {
        debug('failed to validate %s as %s', key, type);
        errors[key] = 'must be a ' + type;
      }
    } else if(prop.required) {
      debug('%s is required', key);
      if(create) {
        errors[key] = 'is required'; 
      }
    } else if(type === 'boolean') {
      body[key] = false;
    }
  });
  
  if(Object.keys(errors).length) return errors;
};

/**
 * Sanitize the request `body` against the `Collection` `properties` 
 * and return an object containing only properties that exist in the
 * `Collection.config.properties` object.
 *
 * @param {Object} body
 * @return {Object} sanitized
 */

Collection.prototype.sanitize = function (body) {
  if(!this.properties) return {};

  var sanitized = {}
    , props = this.properties
    , keys = Object.keys(props);

  keys.forEach(function (key) {
    var prop = props[key]
    , expected = prop.type
    , val = body[key]
    , actual = typeof val;

    // skip properties that do not exist
    if(!prop) return;

    if(expected == actual) {
      sanitized[key] = val;
    } else if (expected === 'array' && Array.isArray(val)) {
      sanitized[key] = val;
    } else if(expected == 'number' && actual == 'string') {
      sanitized[key] = parseFloat(val);
    }
  });

  return sanitized;
};

Collection.prototype.sanitizeQuery = function (query) {
  var sanitized = {}
    , props = this.properties || {}
    , keys = query && Object.keys(query);

  keys && keys.forEach(function (key) {
    var prop = props[key]
    , expected = prop && prop.type
    , val = query[key]
    , actual = typeof val;

    // skip properties that do not exist, but allow $ queries and id
    if(!prop && key.indexOf('$') !== 0 && key !== 'id') return;

    // hack - $limitRecursion and $skipEvents are not mongo properties so we'll get rid of them, too
    if (key === '$limitRecursion') return;
    if (key === '$skipEvents') return;
    
    if(expected == 'number' && actual == 'string') {
      sanitized[key] = parseFloat(val);
    } else if(expected == 'boolean' && actual != 'boolean') {
      sanitized[key] = (val === 'true') ? true : false;
    } else if (typeof val !== 'undefined') {
      sanitized[key] = val;
    }
  });
  
  return sanitized;
};

Collection.prototype.getRequiredPermissions = function (ctx) {
  var requiredPermissions = {}
    , hasId = !!(ctx.query.id || this.parseId(ctx) || (ctx.body && ctx.body.id));
    
  if(hasId) {
    requiredPermissions['querying an object by id'] = true;
  }
    
  switch(ctx.method) {
    case 'GET':
      if(hasId) {
        requiredPermissions['querying an object by id'] = true;
      } else {
        requiredPermissions['querying multiple objects'] = true;
      }
    break;
    case 'POST':
      // TODO ~ account for custom methods
      if(Array.isArray(ctx.body)) {
        requiredPermissions['creating multiple objects'] = true;
      } else if(hasId) {
        requiredPermissions['updating an object by id'] = true;
      } else {
        requiredPermissions['creating an object'] = true;
      }
    break;
    case 'PUT':
      if(hasId) {
        requiredPermissions['updating an object by id'] = true;
        requiredPermissions['querying an object by id'] = true;
      } else {
        requiredPermissions['querying multiple objects'] = true;
        requiredPermissions['updating multiple objects'] = true;
      }
    break;
    case 'DELETE':
      if(hasId) {
        requiredPermissions['deleting an object by id'] = true;
      } else {
        requiredPermissions['deleting multiple objects'] = true;
      }
    break;  
  }
  
  return requiredPermissions;
}


Collection.prototype.getDefaultPermissions = function (ctx) {
  return {
    'querying multiple objects': true,
    'querying an object by id': true,
    'creating an object': true,
    'deleting an object by id': true,
    'updating an object by id': true
  };  
}

/**
 * Handle an incoming http `req` and `res` and execute
 * the correct `Store` proxy function based on `req.method`.
 *
 *
 * @param {ServerRequest} req
 * @param {ServerResponse} res
 */

Collection.prototype.handle = function (ctx) {
  // set id one wasnt provided in the query
  ctx.query.id = ctx.query.id || this.parseId(ctx) || (ctx.body && ctx.body.id);
  
  function handle(err) {
    if(err) return ctx.done(err);
    
    if (ctx.req.method == "GET" && ctx.query.id === 'count') {
      delete ctx.query.id;
      this.count(ctx, ctx.done);
      return;
    }

    if (ctx.req.method == "GET" && ctx.query.id === 'index-of') {
      delete ctx.query.id;
      var id = ctx.url.split('/').filter(function(p) { return p; })[1];
      this.indexOf(id, ctx, ctx.done);
      return;
    }
  
    var eventScript = this.getEventScript(ctx)
      , event = this.parseEvent(ctx); 
  
    if(eventScript) {
      debug('running %s event', eventScript)
      return this.run(event, eventScript, ctx);
    }

    switch(ctx.req.method) {
      case 'GET':
        this.find(ctx, ctx.done);
      break;
      case 'PUT':
        if (!ctx.query.id && ctx.body) {
          return this.saveAll(ctx, ctx.done);
        }
      /* falls through */
      case 'POST':
        this.save(ctx, ctx.done);
      break;
      case 'DELETE':
        this.remove(ctx, ctx.done);
      break;
    }
  }
  
  if(ctx.req.method === 'POST' || ctx.query.id || ctx.url !== '/') {
    handle.call(this);
  } else {
    this.beforeQuery(ctx, handle.bind(this));
  }
};

Collection.prototype.beforeQuery = function (ctx, fn) {
  var queryScript = this.events.Query
    , collection = this;
  
  if(queryScript) {
    var domain = createDomain(this, ctx);
    
    domain.event = ctx.method;
    domain.method = ctx.method;
    domain.action = ctx.method;
    domain.query = ctx.query;
    domain.data = ctx.body;
  
    queryScript.run(ctx, domain, function (err) {
      if(err) return ctx.done(err);
      
      ctx.verifyPermissions(fn);
    });
  } else {
    ctx.verifyPermissions(fn);
  }
}

/**
 * Parse the `ctx.url` for an id
 *
 * @param {Context} ctx
 * @return {String} id
 */

Collection.prototype.parseId = function(ctx) {
  if(ctx.url && ctx.url !== '/') return ctx.url.split('/')[1];
};

Collection.prototype.count = function(ctx, fn) {
  if (ctx.session.isRoot) {
    var collection = this
      , store = this.store
      , sanitizedQuery = this.sanitizeQuery(ctx.query || {});

    store.count(sanitizedQuery, function (err, result) {
      if (err) return fn(err);

      fn(null, {count: result});
    });
  } else {
    fn({
      message: "Must be root to count",
      statusCode: 403
    });
  }
};

Collection.prototype.indexOf = function(id, ctx, fn) {
  if (ctx.session.isRoot) {
    var collection = this
      , store = this.store
      , sanitizedQuery = this.sanitizeQuery(ctx.query || {});

    sanitizedQuery.$fields = {id: 1};

    store.find(sanitizedQuery, function (err, result) {
      if (err) return fn(err);

      var indexOf = result.map(function(r) { return r.id }).indexOf(id);

      fn(null, {index: indexOf});
    });
  } else {
    fn({
      message: "Must be root to get index",
      statusCode: 403
    });
  }
};

/**
 * Find all the objects in a collection that match the given
 * query. Then execute its get script using each object.
 *
 * @param {Context} ctx
 * @param {Function} fn(err, result)
 */

Collection.prototype.find = function (ctx, fn) {
  var collection = this
    , store = this.store
    , query = ctx.query || {}
    , session = ctx.session
    , client = ctx.dpd
    , errors
    , data
    , sanitizedQuery = this.sanitizeQuery(query);

  function done(err, result) {
    debug("Get listener called back with", err || result);
    if(typeof query.id === 'string' && (result && result.length === 0) || !result) {
      err = err || {
        message: 'not found',
        statusCode: 404
      };
      debug('could not find object by id %s', query.id);
    }
    if(err) {
      return fn(err);
    }
    if(typeof query.id === 'string' && Array.isArray(result)) {
      return fn(null, result[0]);
    }
    
    fn(null, result);
  }

  debug('finding %j; sanitized %j', query, sanitizedQuery);
  
  store.find(sanitizedQuery, function (err, result) {
    debug("Find Callback");
    if(err) return done(err);
    debug('found %j', err || result || 'none');
    if(!collection.shouldRunEvent(collection.events.get, ctx)) {
      return done(err, result);
    }

    var errors = {};
    
    if(Array.isArray(result)) {

      var remaining = result && result.length;
      if(!remaining) return done(err, result); 
      result.forEach(function (data) {
        // domain for onGet event scripts
        var domain = createDomain(collection, ctx, data, errors);

        collection.events.get.run(ctx, domain, function (err) {
          if (err) {
            if (err instanceof Error) {
              return done(err);
            } else {
              errors[data.id] = err;
            }
          }

          remaining--;
          if(!remaining) {
            done(null, result.filter(function(r) {
              return !errors[r.id];
            }));
          }
        });
      });
    } else {
      // domain for onGet event scripts
      data = result;
      var domain = createDomain(collection, ctx, data, errors);

      collection.events.get.run(ctx, domain, function (err) {
        if(err) return done(err);
        
        done(null, data);
      });
    }
  });
};

/**
 * Execute a `delete` event script, if one exists, using each object found. 
 * Then remove a single object that matches the `ctx.query.id`. Finally call
 * `fn(err)` passing an `error` if one occurred.
 *
 * @param {Context} ctx
 * @param {Function} fn(err)
 */

Collection.prototype.remove = function (ctx, fn) {
  var collection = this
    , store = this.store
    , session = ctx.session
    , query = ctx.query
    , sanitizedQuery = this.sanitizeQuery(query)
    , errors;
  
  store.find(sanitizedQuery, function (err, result) {
    if(err) {
      return fn(err);
    }
    
    function done(err) {
      if(err) return fn(err);
      ctx.verifyPermissions(function (err) {
        if(err) return fn(err);
        
        store.remove(sanitizedQuery, fn);
        if(session.emitToAll) session.emitToAll(collection.name + ':changed');
      });
    }
    
    if(collection.shouldRunEvent(collection.events.Delete, ctx)) {
      var domain = createDomain(collection, ctx, result, errors);
      
      domain['this'] = domain.data = result;
      collection.events.Delete.run(ctx, domain, done);
    } else {
      done();
    }
  });
};

function buildCommands(item) {
  var commands = {};
  Object.keys(item).forEach(function (key) {
    if(item[key] && typeof item[key] === 'object' && !Array.isArray(item[key])) {
      Object.keys(item[key]).forEach(function (k) {
        if(k[0] == '$') {
          commands[key] = item[key];
        }
      });
    }
  });
  return commands;
}

/**
 * Execute the onPost or onPut listener. If it succeeds, 
 * save the given item in the collection.
 *
 * @param {Context} ctx
 * @param {Function} fn(err, result)
 */

Collection.prototype.save = function (ctx, fn) {
  var collection = this
    , store = this.store
    , session = ctx.session
    , item = ctx.body
    , query = ctx.query || {}
    , client = ctx.dpd
    , errors = {};
     
  if(!item) return done('You must include an object when saving or updating.');

  // build command object
  var commands = buildCommands(item);
  item = this.sanitize(item);

  // handle id on either body or query
  if(item.id) {
    query.id = item.id;
  }

  debug('saving %j with id %s', item, query.id);

  function done(err, item) {
    errors = domain && domain.hasErrors() && {errors: errors};
    debug('errors: %j', err);
    fn(errors || err, item);
  }

  var domain = createDomain(collection, ctx, item, errors);

  domain.protect = function(property) {
    delete domain.data[property];
  };

  domain.changed =  function (property) {
    if(domain.data.hasOwnProperty(property)) {
      if(domain.previous && domain.previous[property] === domain.data[property]) {
        return false;
      }
      
      return true;
    }
    return false;
  };

  domain.previous = {};

  function put() {
    var id = query.id
      , sanitizedQuery = collection.sanitizeQuery(query)
      , prev = {};
     
    store.first(sanitizedQuery, function(err, obj) {
      if(!obj) {
        if (Object.keys(sanitizedQuery) === 1) {
          return done(new Error("No object exists with that id"));  
        } else {
          return done(new Error("No object exists that matches that query"));  
        }
      } 
      if(err) return done(err);

      // copy previous obj
      Object.keys(obj).forEach(function (key) {
        prev[key] = obj[key];
      });

      // merge changes
      Object.keys(item).forEach(function (key) {
        obj[key] = item[key];
      });
      
      prev.id = id;
      item = obj;
      domain['this'] = item;
      domain.data = item;
      domain.previous = prev;

      collection.execCommands('update', item, commands);

      var errs = collection.validate(item);
     
      if(errs) return done({errors: errs});

      function runPutEvent(err) {
        if(err) {
          return done(err);
        }

        if(collection.shouldRunEvent(collection.events.Put, ctx)) {
          collection.events.Put.run(ctx, domain, commit);
        } else {
          commit();
        }
      }
     
      function commit(err) {
        if(err || domain.hasErrors()) {
          return done(err || errors);
        }
        
        ctx.verifyPermissions(function (err) {
          if(err) {
            return done(err);
          }

          delete item.id;
          store.update({id: query.id}, item, function (err) {
            if(err) return done(err);
            item.id = id;
         
            done(null, item);

            if(session && session.emitToAll) session.emitToAll(collection.name + ':changed');
          });
        });
      }

      if (collection.shouldRunEvent(collection.events.Validate, ctx)) {
        collection.events.Validate.run(ctx, domain, function (err) {
          if(err || domain.hasErrors()) return done(err || errors);
          runPutEvent(err);
        });
      } else {
        runPutEvent();
      }
    });
  }
 
  function post() {
    var errs = collection.validate(item, true);

    if(errs) return done({errors: errs});

    // generate id before event listener
    item.id = store.createUniqueIdentifier();
   
    if(collection.shouldRunEvent(collection.events.Post, ctx)) {
      collection.events.Post.run(ctx, domain, function (err) {
        if(err) {
          debug('onPost script error %j', err);
          return done(err);
        }
        if(err || domain.hasErrors()) return done(err || errors);
        debug('inserting item', item);
        ctx.verifyPermissions(function (err) {
          if(err) return done(err);
          store.insert(item, done);
          if(session && session.emitToAll) session.emitToAll(collection.name + ':changed');
        });
      });
    } else {
      ctx.verifyPermissions(function (err) {
        if(err) return done(err);
        store.insert(item, done);
         if(session && session.emitToAll) session.emitToAll(collection.name + ':changed');
      });
    }
  }

  if (query.id) {
    put();
  } else if (collection.shouldRunEvent(collection.events.Validate, ctx)) {
    collection.events.Validate.run(ctx, domain, function (err) {
      if(err || domain.hasErrors()) return done(err || errors);
      post();
    });
  } else {
    post();
  }
};

Collection.prototype.saveAll = function (ctx, fn) {
  var errors = {}
    , results = []
    , updateBatch = []
    , objectsToUpdate
    , failed
    , collection = this
    , query = ctx.query
    , item = ctx.body
    , sanitizedQuery = collection.sanitizeQuery(query)
    , commands = buildCommands(item);
    
  this.store.find(sanitizedQuery, function (err, objects) {
    if(err) return fn(err);
    var remaining;
      
    objectsToUpdate = objects;
    
    if(Array.isArray(objects)) {
      remaining = objects.length;
      for(var i = 0; i < objects.length && !failed; i++) {
        update(objects[i]);
      };
    } else {
      done();
    }
  });
      
  function update(obj) {
    var id = query.id
      , prev = {}
      , updated = {}
      , domain = createDomain(collection, ctx, obj, errors);

    // copy item
    Object.keys(obj).forEach(function (key) {
      updated[key] = obj[key];
      prev[key] = obj[key];
      if(item[key]) updated[key] = item[key];
    });
    Object.keys(item).forEach(function (key) {
      updated[key] = item[key];
    });
    
    domain['this'] = updated;
    domain.data = updated;
    domain.previous = prev;

    domain.protect = function(property) {
      delete domain.data[property];
    };

    domain.changed =  function (property) {
      if(domain.data.hasOwnProperty(property)) return true;
      return false;
    };

    collection.execCommands('update', updated, commands);

    var errs = collection.validate(updated);
     
    if(errs) return done({errors: errs});
    
    if(collection.shouldRunEvent(collection.events.Validate, ctx)) {
      collection.events.Validate.run(ctx, domain, function (err) {
        if(err || domain.hasErrors()) return done(err || errors);
        runPutEvent(err);
      });
    } else {
      runPutEvent();
    }
    
    function runPutEvent() {
      if(collection.shouldRunEvent(collection.events.Put, ctx)) {
        collection.events.Put.run(ctx, domain, add);
      } else {
        add();
      }
    }
    
    function add(err) {
      if(err) return done(err);
      ctx.verifyPermissions(function (err) {
        if(err) return done(err);
        
        updateBatch.push(updated);
      
        if(updateBatch.length === objectsToUpdate.length) {
          done();
        }
      });
    }
  }
  
  function done(err) {
    if(err) {
      debug('errors: %j', err);
      fn(err);
    } else if(updateBatch.length) {
      updateBatch.forEach(function (obj) {
        var id = obj.id;
        delete obj.id;
        results.push(id);
        collection.store.update({id: id}, obj);
      });
      
      fn(null, results);
    } else {
      fn(null, []);
    }
  }
}
 
function createDomain(collection, ctx, data, errors) {
  var hasErrors = false;
  var domain = {
    allow: ctx.allow.bind(ctx),
    prevent: ctx.prevent.bind(ctx),
    error: function(key, val) {
      debug('error %s %s', key, val);
      errors[key] = val || true;
      hasErrors = true;
    },
    errorIf: function(condition, key, value) {
      if (condition) {
        domain.error(key, value);
      }
    },
    errorUnless: function(condition, key, value) {
      domain.errorIf(!condition, key, value);
    },
    hasErrors: function() {
      return hasErrors;
    },
    hide: function(property) {
      delete domain.data[property];
    },
    'this': data,
    data: data
  };
  return domain;
}

Collection.defaultPath = '/my-objects';

Collection.prototype.configDeleted = function(config, fn) {
  debug('resource deleted');
  return this.store.remove(fn);
};

Collection.prototype.configChanged = function(config, fn) {
  var store = this.store;

  debug('resource changed');

  var properties = config && config.properties
    , renames;
  
  if(config.id && config.id !== this.name) {
    store.rename(config.id.replace('/', ''), function (err) {
        fn(err);
    });
    return;
  }

  fn(null);
};

Collection.prototype.external.rename = function (options, ctx, fn) {
  if(!ctx.req && !ctx.req.isRoot) return fn(new Error('cannot rename multiple'));
  
  if(options.properties) {
    this.store.update({}, {$rename: options.properties}, fn);
  }
};

Collection.prototype.execCommands = function (type, obj, commands) {
  try {
    if(type === 'update') {
      Object.keys(commands).forEach(function (key) {
        if(typeof commands[key] == 'object') {
          Object.keys(commands[key]).forEach(function (k) {
            if(k[0] !== '$') return;

            var val = commands[key][k];

            if(k === '$inc') {
              if(!obj[key]) obj[key] = 0;
              obj[key] += val;
            }
            if(k === '$push') {
              if(Array.isArray(obj[key])) {
                obj[key].push(val);
              } else {
                obj[key] = [val];
              }
            }
            if(k === '$pushAll') {
              if(Array.isArray(obj[key])) {
                if(Array.isArray(val)) {
                  for(var i = 0; i < val.length; i++) {
                    obj[key].push(val[i]); 
                  }
                }
              } else {
                obj[key] = val;
              }
            }
            if (k === '$pull') {
              if(Array.isArray(obj[key])) {
                obj[key] = obj[key].filter(function(item) {
                  return item !== val;
                });
              }
            }
            if (k === '$pullAll') {
              if(Array.isArray(obj[key])) {
                if(Array.isArray(val)) {
                  obj[key] = obj[key].filter(function(item) {
                    return val.indexOf(item) === -1;
                  });
                }
              }
            }
          });
        }
      });
    }
  } catch(e) {
    debug('error while executing commands', type, obj, commands);
  }
  return this;
};

Collection.prototype.shouldRunEvent = function(ev, ctx) {
  var skipEvents = ctx && ((ctx.body && ctx.body.$skipEvents) || (ctx.query && ctx.query.$skipEvents))
    , rootPrevent = ctx && ctx.session && ctx.session.isRoot && skipEvents;
  return !rootPrevent && ev;
};

module.exports = Collection;