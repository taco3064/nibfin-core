import { readFileSync } from 'node:fs';
import { setTimeout as setTimeout$1 } from 'node:timers/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { pipeline, Readable } from 'node:stream';
import { tmpdir } from 'node:os';

var commonjsGlobal = typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : typeof self !== 'undefined' ? self : {};

function getDefaultExportFromCjs (x) {
	return x && x.__esModule && Object.prototype.hasOwnProperty.call(x, 'default') ? x['default'] : x;
}

var light$1 = {exports: {}};

/**
  * This file contains the Bottleneck library (MIT), compiled to ES2017, and without Clustering support.
  * https://github.com/SGrondin/bottleneck
  */
var light = light$1.exports;

var hasRequiredLight;

function requireLight () {
	if (hasRequiredLight) return light$1.exports;
	hasRequiredLight = 1;
	(function (module, exports) {
		(function (global, factory) {
			module.exports = factory() ;
		}(light, (function () {
			var commonjsGlobal$1 = typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : typeof commonjsGlobal !== 'undefined' ? commonjsGlobal : typeof self !== 'undefined' ? self : {};

			function getCjsExportFromNamespace (n) {
				return n && n['default'] || n;
			}

			var load = function(received, defaults, onto = {}) {
			  var k, ref, v;
			  for (k in defaults) {
			    v = defaults[k];
			    onto[k] = (ref = received[k]) != null ? ref : v;
			  }
			  return onto;
			};

			var overwrite = function(received, defaults, onto = {}) {
			  var k, v;
			  for (k in received) {
			    v = received[k];
			    if (defaults[k] !== void 0) {
			      onto[k] = v;
			    }
			  }
			  return onto;
			};

			var parser = {
				load: load,
				overwrite: overwrite
			};

			var DLList;

			DLList = class DLList {
			  constructor(incr, decr) {
			    this.incr = incr;
			    this.decr = decr;
			    this._first = null;
			    this._last = null;
			    this.length = 0;
			  }

			  push(value) {
			    var node;
			    this.length++;
			    if (typeof this.incr === "function") {
			      this.incr();
			    }
			    node = {
			      value,
			      prev: this._last,
			      next: null
			    };
			    if (this._last != null) {
			      this._last.next = node;
			      this._last = node;
			    } else {
			      this._first = this._last = node;
			    }
			    return void 0;
			  }

			  shift() {
			    var value;
			    if (this._first == null) {
			      return;
			    } else {
			      this.length--;
			      if (typeof this.decr === "function") {
			        this.decr();
			      }
			    }
			    value = this._first.value;
			    if ((this._first = this._first.next) != null) {
			      this._first.prev = null;
			    } else {
			      this._last = null;
			    }
			    return value;
			  }

			  first() {
			    if (this._first != null) {
			      return this._first.value;
			    }
			  }

			  getArray() {
			    var node, ref, results;
			    node = this._first;
			    results = [];
			    while (node != null) {
			      results.push((ref = node, node = node.next, ref.value));
			    }
			    return results;
			  }

			  forEachShift(cb) {
			    var node;
			    node = this.shift();
			    while (node != null) {
			      (cb(node), node = this.shift());
			    }
			    return void 0;
			  }

			  debug() {
			    var node, ref, ref1, ref2, results;
			    node = this._first;
			    results = [];
			    while (node != null) {
			      results.push((ref = node, node = node.next, {
			        value: ref.value,
			        prev: (ref1 = ref.prev) != null ? ref1.value : void 0,
			        next: (ref2 = ref.next) != null ? ref2.value : void 0
			      }));
			    }
			    return results;
			  }

			};

			var DLList_1 = DLList;

			var Events;

			Events = class Events {
			  constructor(instance) {
			    this.instance = instance;
			    this._events = {};
			    if ((this.instance.on != null) || (this.instance.once != null) || (this.instance.removeAllListeners != null)) {
			      throw new Error("An Emitter already exists for this object");
			    }
			    this.instance.on = (name, cb) => {
			      return this._addListener(name, "many", cb);
			    };
			    this.instance.once = (name, cb) => {
			      return this._addListener(name, "once", cb);
			    };
			    this.instance.removeAllListeners = (name = null) => {
			      if (name != null) {
			        return delete this._events[name];
			      } else {
			        return this._events = {};
			      }
			    };
			  }

			  _addListener(name, status, cb) {
			    var base;
			    if ((base = this._events)[name] == null) {
			      base[name] = [];
			    }
			    this._events[name].push({cb, status});
			    return this.instance;
			  }

			  listenerCount(name) {
			    if (this._events[name] != null) {
			      return this._events[name].length;
			    } else {
			      return 0;
			    }
			  }

			  async trigger(name, ...args) {
			    var e, promises;
			    try {
			      if (name !== "debug") {
			        this.trigger("debug", `Event triggered: ${name}`, args);
			      }
			      if (this._events[name] == null) {
			        return;
			      }
			      this._events[name] = this._events[name].filter(function(listener) {
			        return listener.status !== "none";
			      });
			      promises = this._events[name].map(async(listener) => {
			        var e, returned;
			        if (listener.status === "none") {
			          return;
			        }
			        if (listener.status === "once") {
			          listener.status = "none";
			        }
			        try {
			          returned = typeof listener.cb === "function" ? listener.cb(...args) : void 0;
			          if (typeof (returned != null ? returned.then : void 0) === "function") {
			            return (await returned);
			          } else {
			            return returned;
			          }
			        } catch (error) {
			          e = error;
			          {
			            this.trigger("error", e);
			          }
			          return null;
			        }
			      });
			      return ((await Promise.all(promises))).find(function(x) {
			        return x != null;
			      });
			    } catch (error) {
			      e = error;
			      {
			        this.trigger("error", e);
			      }
			      return null;
			    }
			  }

			};

			var Events_1 = Events;

			var DLList$1, Events$1, Queues;

			DLList$1 = DLList_1;

			Events$1 = Events_1;

			Queues = class Queues {
			  constructor(num_priorities) {
			    this.Events = new Events$1(this);
			    this._length = 0;
			    this._lists = (function() {
			      var j, ref, results;
			      results = [];
			      for (j = 1, ref = num_priorities; (1 <= ref ? j <= ref : j >= ref); 1 <= ref ? ++j : --j) {
			        results.push(new DLList$1((() => {
			          return this.incr();
			        }), (() => {
			          return this.decr();
			        })));
			      }
			      return results;
			    }).call(this);
			  }

			  incr() {
			    if (this._length++ === 0) {
			      return this.Events.trigger("leftzero");
			    }
			  }

			  decr() {
			    if (--this._length === 0) {
			      return this.Events.trigger("zero");
			    }
			  }

			  push(job) {
			    return this._lists[job.options.priority].push(job);
			  }

			  queued(priority) {
			    if (priority != null) {
			      return this._lists[priority].length;
			    } else {
			      return this._length;
			    }
			  }

			  shiftAll(fn) {
			    return this._lists.forEach(function(list) {
			      return list.forEachShift(fn);
			    });
			  }

			  getFirst(arr = this._lists) {
			    var j, len, list;
			    for (j = 0, len = arr.length; j < len; j++) {
			      list = arr[j];
			      if (list.length > 0) {
			        return list;
			      }
			    }
			    return [];
			  }

			  shiftLastFrom(priority) {
			    return this.getFirst(this._lists.slice(priority).reverse()).shift();
			  }

			};

			var Queues_1 = Queues;

			var BottleneckError;

			BottleneckError = class BottleneckError extends Error {};

			var BottleneckError_1 = BottleneckError;

			var BottleneckError$1, DEFAULT_PRIORITY, Job, NUM_PRIORITIES, parser$1;

			NUM_PRIORITIES = 10;

			DEFAULT_PRIORITY = 5;

			parser$1 = parser;

			BottleneckError$1 = BottleneckError_1;

			Job = class Job {
			  constructor(task, args, options, jobDefaults, rejectOnDrop, Events, _states, Promise) {
			    this.task = task;
			    this.args = args;
			    this.rejectOnDrop = rejectOnDrop;
			    this.Events = Events;
			    this._states = _states;
			    this.Promise = Promise;
			    this.options = parser$1.load(options, jobDefaults);
			    this.options.priority = this._sanitizePriority(this.options.priority);
			    if (this.options.id === jobDefaults.id) {
			      this.options.id = `${this.options.id}-${this._randomIndex()}`;
			    }
			    this.promise = new this.Promise((_resolve, _reject) => {
			      this._resolve = _resolve;
			      this._reject = _reject;
			    });
			    this.retryCount = 0;
			  }

			  _sanitizePriority(priority) {
			    var sProperty;
			    sProperty = ~~priority !== priority ? DEFAULT_PRIORITY : priority;
			    if (sProperty < 0) {
			      return 0;
			    } else if (sProperty > NUM_PRIORITIES - 1) {
			      return NUM_PRIORITIES - 1;
			    } else {
			      return sProperty;
			    }
			  }

			  _randomIndex() {
			    return Math.random().toString(36).slice(2);
			  }

			  doDrop({error, message = "This job has been dropped by Bottleneck"} = {}) {
			    if (this._states.remove(this.options.id)) {
			      if (this.rejectOnDrop) {
			        this._reject(error != null ? error : new BottleneckError$1(message));
			      }
			      this.Events.trigger("dropped", {args: this.args, options: this.options, task: this.task, promise: this.promise});
			      return true;
			    } else {
			      return false;
			    }
			  }

			  _assertStatus(expected) {
			    var status;
			    status = this._states.jobStatus(this.options.id);
			    if (!(status === expected || (expected === "DONE" && status === null))) {
			      throw new BottleneckError$1(`Invalid job status ${status}, expected ${expected}. Please open an issue at https://github.com/SGrondin/bottleneck/issues`);
			    }
			  }

			  doReceive() {
			    this._states.start(this.options.id);
			    return this.Events.trigger("received", {args: this.args, options: this.options});
			  }

			  doQueue(reachedHWM, blocked) {
			    this._assertStatus("RECEIVED");
			    this._states.next(this.options.id);
			    return this.Events.trigger("queued", {args: this.args, options: this.options, reachedHWM, blocked});
			  }

			  doRun() {
			    if (this.retryCount === 0) {
			      this._assertStatus("QUEUED");
			      this._states.next(this.options.id);
			    } else {
			      this._assertStatus("EXECUTING");
			    }
			    return this.Events.trigger("scheduled", {args: this.args, options: this.options});
			  }

			  async doExecute(chained, clearGlobalState, run, free) {
			    var error, eventInfo, passed;
			    if (this.retryCount === 0) {
			      this._assertStatus("RUNNING");
			      this._states.next(this.options.id);
			    } else {
			      this._assertStatus("EXECUTING");
			    }
			    eventInfo = {args: this.args, options: this.options, retryCount: this.retryCount};
			    this.Events.trigger("executing", eventInfo);
			    try {
			      passed = (await (chained != null ? chained.schedule(this.options, this.task, ...this.args) : this.task(...this.args)));
			      if (clearGlobalState()) {
			        this.doDone(eventInfo);
			        await free(this.options, eventInfo);
			        this._assertStatus("DONE");
			        return this._resolve(passed);
			      }
			    } catch (error1) {
			      error = error1;
			      return this._onFailure(error, eventInfo, clearGlobalState, run, free);
			    }
			  }

			  doExpire(clearGlobalState, run, free) {
			    var error, eventInfo;
			    if (this._states.jobStatus(this.options.id === "RUNNING")) {
			      this._states.next(this.options.id);
			    }
			    this._assertStatus("EXECUTING");
			    eventInfo = {args: this.args, options: this.options, retryCount: this.retryCount};
			    error = new BottleneckError$1(`This job timed out after ${this.options.expiration} ms.`);
			    return this._onFailure(error, eventInfo, clearGlobalState, run, free);
			  }

			  async _onFailure(error, eventInfo, clearGlobalState, run, free) {
			    var retry, retryAfter;
			    if (clearGlobalState()) {
			      retry = (await this.Events.trigger("failed", error, eventInfo));
			      if (retry != null) {
			        retryAfter = ~~retry;
			        this.Events.trigger("retry", `Retrying ${this.options.id} after ${retryAfter} ms`, eventInfo);
			        this.retryCount++;
			        return run(retryAfter);
			      } else {
			        this.doDone(eventInfo);
			        await free(this.options, eventInfo);
			        this._assertStatus("DONE");
			        return this._reject(error);
			      }
			    }
			  }

			  doDone(eventInfo) {
			    this._assertStatus("EXECUTING");
			    this._states.next(this.options.id);
			    return this.Events.trigger("done", eventInfo);
			  }

			};

			var Job_1 = Job;

			var BottleneckError$2, LocalDatastore, parser$2;

			parser$2 = parser;

			BottleneckError$2 = BottleneckError_1;

			LocalDatastore = class LocalDatastore {
			  constructor(instance, storeOptions, storeInstanceOptions) {
			    this.instance = instance;
			    this.storeOptions = storeOptions;
			    this.clientId = this.instance._randomIndex();
			    parser$2.load(storeInstanceOptions, storeInstanceOptions, this);
			    this._nextRequest = this._lastReservoirRefresh = this._lastReservoirIncrease = Date.now();
			    this._running = 0;
			    this._done = 0;
			    this._unblockTime = 0;
			    this.ready = this.Promise.resolve();
			    this.clients = {};
			    this._startHeartbeat();
			  }

			  _startHeartbeat() {
			    var base;
			    if ((this.heartbeat == null) && (((this.storeOptions.reservoirRefreshInterval != null) && (this.storeOptions.reservoirRefreshAmount != null)) || ((this.storeOptions.reservoirIncreaseInterval != null) && (this.storeOptions.reservoirIncreaseAmount != null)))) {
			      return typeof (base = (this.heartbeat = setInterval(() => {
			        var amount, incr, maximum, now, reservoir;
			        now = Date.now();
			        if ((this.storeOptions.reservoirRefreshInterval != null) && now >= this._lastReservoirRefresh + this.storeOptions.reservoirRefreshInterval) {
			          this._lastReservoirRefresh = now;
			          this.storeOptions.reservoir = this.storeOptions.reservoirRefreshAmount;
			          this.instance._drainAll(this.computeCapacity());
			        }
			        if ((this.storeOptions.reservoirIncreaseInterval != null) && now >= this._lastReservoirIncrease + this.storeOptions.reservoirIncreaseInterval) {
			          ({
			            reservoirIncreaseAmount: amount,
			            reservoirIncreaseMaximum: maximum,
			            reservoir
			          } = this.storeOptions);
			          this._lastReservoirIncrease = now;
			          incr = maximum != null ? Math.min(amount, maximum - reservoir) : amount;
			          if (incr > 0) {
			            this.storeOptions.reservoir += incr;
			            return this.instance._drainAll(this.computeCapacity());
			          }
			        }
			      }, this.heartbeatInterval))).unref === "function" ? base.unref() : void 0;
			    } else {
			      return clearInterval(this.heartbeat);
			    }
			  }

			  async __publish__(message) {
			    await this.yieldLoop();
			    return this.instance.Events.trigger("message", message.toString());
			  }

			  async __disconnect__(flush) {
			    await this.yieldLoop();
			    clearInterval(this.heartbeat);
			    return this.Promise.resolve();
			  }

			  yieldLoop(t = 0) {
			    return new this.Promise(function(resolve, reject) {
			      return setTimeout(resolve, t);
			    });
			  }

			  computePenalty() {
			    var ref;
			    return (ref = this.storeOptions.penalty) != null ? ref : (15 * this.storeOptions.minTime) || 5000;
			  }

			  async __updateSettings__(options) {
			    await this.yieldLoop();
			    parser$2.overwrite(options, options, this.storeOptions);
			    this._startHeartbeat();
			    this.instance._drainAll(this.computeCapacity());
			    return true;
			  }

			  async __running__() {
			    await this.yieldLoop();
			    return this._running;
			  }

			  async __queued__() {
			    await this.yieldLoop();
			    return this.instance.queued();
			  }

			  async __done__() {
			    await this.yieldLoop();
			    return this._done;
			  }

			  async __groupCheck__(time) {
			    await this.yieldLoop();
			    return (this._nextRequest + this.timeout) < time;
			  }

			  computeCapacity() {
			    var maxConcurrent, reservoir;
			    ({maxConcurrent, reservoir} = this.storeOptions);
			    if ((maxConcurrent != null) && (reservoir != null)) {
			      return Math.min(maxConcurrent - this._running, reservoir);
			    } else if (maxConcurrent != null) {
			      return maxConcurrent - this._running;
			    } else if (reservoir != null) {
			      return reservoir;
			    } else {
			      return null;
			    }
			  }

			  conditionsCheck(weight) {
			    var capacity;
			    capacity = this.computeCapacity();
			    return (capacity == null) || weight <= capacity;
			  }

			  async __incrementReservoir__(incr) {
			    var reservoir;
			    await this.yieldLoop();
			    reservoir = this.storeOptions.reservoir += incr;
			    this.instance._drainAll(this.computeCapacity());
			    return reservoir;
			  }

			  async __currentReservoir__() {
			    await this.yieldLoop();
			    return this.storeOptions.reservoir;
			  }

			  isBlocked(now) {
			    return this._unblockTime >= now;
			  }

			  check(weight, now) {
			    return this.conditionsCheck(weight) && (this._nextRequest - now) <= 0;
			  }

			  async __check__(weight) {
			    var now;
			    await this.yieldLoop();
			    now = Date.now();
			    return this.check(weight, now);
			  }

			  async __register__(index, weight, expiration) {
			    var now, wait;
			    await this.yieldLoop();
			    now = Date.now();
			    if (this.conditionsCheck(weight)) {
			      this._running += weight;
			      if (this.storeOptions.reservoir != null) {
			        this.storeOptions.reservoir -= weight;
			      }
			      wait = Math.max(this._nextRequest - now, 0);
			      this._nextRequest = now + wait + this.storeOptions.minTime;
			      return {
			        success: true,
			        wait,
			        reservoir: this.storeOptions.reservoir
			      };
			    } else {
			      return {
			        success: false
			      };
			    }
			  }

			  strategyIsBlock() {
			    return this.storeOptions.strategy === 3;
			  }

			  async __submit__(queueLength, weight) {
			    var blocked, now, reachedHWM;
			    await this.yieldLoop();
			    if ((this.storeOptions.maxConcurrent != null) && weight > this.storeOptions.maxConcurrent) {
			      throw new BottleneckError$2(`Impossible to add a job having a weight of ${weight} to a limiter having a maxConcurrent setting of ${this.storeOptions.maxConcurrent}`);
			    }
			    now = Date.now();
			    reachedHWM = (this.storeOptions.highWater != null) && queueLength === this.storeOptions.highWater && !this.check(weight, now);
			    blocked = this.strategyIsBlock() && (reachedHWM || this.isBlocked(now));
			    if (blocked) {
			      this._unblockTime = now + this.computePenalty();
			      this._nextRequest = this._unblockTime + this.storeOptions.minTime;
			      this.instance._dropAllQueued();
			    }
			    return {
			      reachedHWM,
			      blocked,
			      strategy: this.storeOptions.strategy
			    };
			  }

			  async __free__(index, weight) {
			    await this.yieldLoop();
			    this._running -= weight;
			    this._done += weight;
			    this.instance._drainAll(this.computeCapacity());
			    return {
			      running: this._running
			    };
			  }

			};

			var LocalDatastore_1 = LocalDatastore;

			var BottleneckError$3, States;

			BottleneckError$3 = BottleneckError_1;

			States = class States {
			  constructor(status1) {
			    this.status = status1;
			    this._jobs = {};
			    this.counts = this.status.map(function() {
			      return 0;
			    });
			  }

			  next(id) {
			    var current, next;
			    current = this._jobs[id];
			    next = current + 1;
			    if ((current != null) && next < this.status.length) {
			      this.counts[current]--;
			      this.counts[next]++;
			      return this._jobs[id]++;
			    } else if (current != null) {
			      this.counts[current]--;
			      return delete this._jobs[id];
			    }
			  }

			  start(id) {
			    var initial;
			    initial = 0;
			    this._jobs[id] = initial;
			    return this.counts[initial]++;
			  }

			  remove(id) {
			    var current;
			    current = this._jobs[id];
			    if (current != null) {
			      this.counts[current]--;
			      delete this._jobs[id];
			    }
			    return current != null;
			  }

			  jobStatus(id) {
			    var ref;
			    return (ref = this.status[this._jobs[id]]) != null ? ref : null;
			  }

			  statusJobs(status) {
			    var k, pos, ref, results, v;
			    if (status != null) {
			      pos = this.status.indexOf(status);
			      if (pos < 0) {
			        throw new BottleneckError$3(`status must be one of ${this.status.join(', ')}`);
			      }
			      ref = this._jobs;
			      results = [];
			      for (k in ref) {
			        v = ref[k];
			        if (v === pos) {
			          results.push(k);
			        }
			      }
			      return results;
			    } else {
			      return Object.keys(this._jobs);
			    }
			  }

			  statusCounts() {
			    return this.counts.reduce(((acc, v, i) => {
			      acc[this.status[i]] = v;
			      return acc;
			    }), {});
			  }

			};

			var States_1 = States;

			var DLList$2, Sync;

			DLList$2 = DLList_1;

			Sync = class Sync {
			  constructor(name, Promise) {
			    this.schedule = this.schedule.bind(this);
			    this.name = name;
			    this.Promise = Promise;
			    this._running = 0;
			    this._queue = new DLList$2();
			  }

			  isEmpty() {
			    return this._queue.length === 0;
			  }

			  async _tryToRun() {
			    var args, cb, error, reject, resolve, returned, task;
			    if ((this._running < 1) && this._queue.length > 0) {
			      this._running++;
			      ({task, args, resolve, reject} = this._queue.shift());
			      cb = (await (async function() {
			        try {
			          returned = (await task(...args));
			          return function() {
			            return resolve(returned);
			          };
			        } catch (error1) {
			          error = error1;
			          return function() {
			            return reject(error);
			          };
			        }
			      })());
			      this._running--;
			      this._tryToRun();
			      return cb();
			    }
			  }

			  schedule(task, ...args) {
			    var promise, reject, resolve;
			    resolve = reject = null;
			    promise = new this.Promise(function(_resolve, _reject) {
			      resolve = _resolve;
			      return reject = _reject;
			    });
			    this._queue.push({task, args, resolve, reject});
			    this._tryToRun();
			    return promise;
			  }

			};

			var Sync_1 = Sync;

			var version = "2.19.5";
			var version$1 = {
				version: version
			};

			var version$2 = /*#__PURE__*/Object.freeze({
				version: version,
				default: version$1
			});

			var require$$2 = () => console.log('You must import the full version of Bottleneck in order to use this feature.');

			var require$$3 = () => console.log('You must import the full version of Bottleneck in order to use this feature.');

			var require$$4 = () => console.log('You must import the full version of Bottleneck in order to use this feature.');

			var Events$2, Group, IORedisConnection$1, RedisConnection$1, Scripts$1, parser$3;

			parser$3 = parser;

			Events$2 = Events_1;

			RedisConnection$1 = require$$2;

			IORedisConnection$1 = require$$3;

			Scripts$1 = require$$4;

			Group = (function() {
			  class Group {
			    constructor(limiterOptions = {}) {
			      this.deleteKey = this.deleteKey.bind(this);
			      this.limiterOptions = limiterOptions;
			      parser$3.load(this.limiterOptions, this.defaults, this);
			      this.Events = new Events$2(this);
			      this.instances = {};
			      this.Bottleneck = Bottleneck_1;
			      this._startAutoCleanup();
			      this.sharedConnection = this.connection != null;
			      if (this.connection == null) {
			        if (this.limiterOptions.datastore === "redis") {
			          this.connection = new RedisConnection$1(Object.assign({}, this.limiterOptions, {Events: this.Events}));
			        } else if (this.limiterOptions.datastore === "ioredis") {
			          this.connection = new IORedisConnection$1(Object.assign({}, this.limiterOptions, {Events: this.Events}));
			        }
			      }
			    }

			    key(key = "") {
			      var ref;
			      return (ref = this.instances[key]) != null ? ref : (() => {
			        var limiter;
			        limiter = this.instances[key] = new this.Bottleneck(Object.assign(this.limiterOptions, {
			          id: `${this.id}-${key}`,
			          timeout: this.timeout,
			          connection: this.connection
			        }));
			        this.Events.trigger("created", limiter, key);
			        return limiter;
			      })();
			    }

			    async deleteKey(key = "") {
			      var deleted, instance;
			      instance = this.instances[key];
			      if (this.connection) {
			        deleted = (await this.connection.__runCommand__(['del', ...Scripts$1.allKeys(`${this.id}-${key}`)]));
			      }
			      if (instance != null) {
			        delete this.instances[key];
			        await instance.disconnect();
			      }
			      return (instance != null) || deleted > 0;
			    }

			    limiters() {
			      var k, ref, results, v;
			      ref = this.instances;
			      results = [];
			      for (k in ref) {
			        v = ref[k];
			        results.push({
			          key: k,
			          limiter: v
			        });
			      }
			      return results;
			    }

			    keys() {
			      return Object.keys(this.instances);
			    }

			    async clusterKeys() {
			      var cursor, end, found, i, k, keys, len, next, start;
			      if (this.connection == null) {
			        return this.Promise.resolve(this.keys());
			      }
			      keys = [];
			      cursor = null;
			      start = `b_${this.id}-`.length;
			      end = "_settings".length;
			      while (cursor !== 0) {
			        [next, found] = (await this.connection.__runCommand__(["scan", cursor != null ? cursor : 0, "match", `b_${this.id}-*_settings`, "count", 10000]));
			        cursor = ~~next;
			        for (i = 0, len = found.length; i < len; i++) {
			          k = found[i];
			          keys.push(k.slice(start, -end));
			        }
			      }
			      return keys;
			    }

			    _startAutoCleanup() {
			      var base;
			      clearInterval(this.interval);
			      return typeof (base = (this.interval = setInterval(async() => {
			        var e, k, ref, results, time, v;
			        time = Date.now();
			        ref = this.instances;
			        results = [];
			        for (k in ref) {
			          v = ref[k];
			          try {
			            if ((await v._store.__groupCheck__(time))) {
			              results.push(this.deleteKey(k));
			            } else {
			              results.push(void 0);
			            }
			          } catch (error) {
			            e = error;
			            results.push(v.Events.trigger("error", e));
			          }
			        }
			        return results;
			      }, this.timeout / 2))).unref === "function" ? base.unref() : void 0;
			    }

			    updateSettings(options = {}) {
			      parser$3.overwrite(options, this.defaults, this);
			      parser$3.overwrite(options, options, this.limiterOptions);
			      if (options.timeout != null) {
			        return this._startAutoCleanup();
			      }
			    }

			    disconnect(flush = true) {
			      var ref;
			      if (!this.sharedConnection) {
			        return (ref = this.connection) != null ? ref.disconnect(flush) : void 0;
			      }
			    }

			  }
			  Group.prototype.defaults = {
			    timeout: 1000 * 60 * 5,
			    connection: null,
			    Promise: Promise,
			    id: "group-key"
			  };

			  return Group;

			}).call(commonjsGlobal$1);

			var Group_1 = Group;

			var Batcher, Events$3, parser$4;

			parser$4 = parser;

			Events$3 = Events_1;

			Batcher = (function() {
			  class Batcher {
			    constructor(options = {}) {
			      this.options = options;
			      parser$4.load(this.options, this.defaults, this);
			      this.Events = new Events$3(this);
			      this._arr = [];
			      this._resetPromise();
			      this._lastFlush = Date.now();
			    }

			    _resetPromise() {
			      return this._promise = new this.Promise((res, rej) => {
			        return this._resolve = res;
			      });
			    }

			    _flush() {
			      clearTimeout(this._timeout);
			      this._lastFlush = Date.now();
			      this._resolve();
			      this.Events.trigger("batch", this._arr);
			      this._arr = [];
			      return this._resetPromise();
			    }

			    add(data) {
			      var ret;
			      this._arr.push(data);
			      ret = this._promise;
			      if (this._arr.length === this.maxSize) {
			        this._flush();
			      } else if ((this.maxTime != null) && this._arr.length === 1) {
			        this._timeout = setTimeout(() => {
			          return this._flush();
			        }, this.maxTime);
			      }
			      return ret;
			    }

			  }
			  Batcher.prototype.defaults = {
			    maxTime: null,
			    maxSize: null,
			    Promise: Promise
			  };

			  return Batcher;

			}).call(commonjsGlobal$1);

			var Batcher_1 = Batcher;

			var require$$4$1 = () => console.log('You must import the full version of Bottleneck in order to use this feature.');

			var require$$8 = getCjsExportFromNamespace(version$2);

			var Bottleneck, DEFAULT_PRIORITY$1, Events$4, Job$1, LocalDatastore$1, NUM_PRIORITIES$1, Queues$1, RedisDatastore$1, States$1, Sync$1, parser$5,
			  splice = [].splice;

			NUM_PRIORITIES$1 = 10;

			DEFAULT_PRIORITY$1 = 5;

			parser$5 = parser;

			Queues$1 = Queues_1;

			Job$1 = Job_1;

			LocalDatastore$1 = LocalDatastore_1;

			RedisDatastore$1 = require$$4$1;

			Events$4 = Events_1;

			States$1 = States_1;

			Sync$1 = Sync_1;

			Bottleneck = (function() {
			  class Bottleneck {
			    constructor(options = {}, ...invalid) {
			      var storeInstanceOptions, storeOptions;
			      this._addToQueue = this._addToQueue.bind(this);
			      this._validateOptions(options, invalid);
			      parser$5.load(options, this.instanceDefaults, this);
			      this._queues = new Queues$1(NUM_PRIORITIES$1);
			      this._scheduled = {};
			      this._states = new States$1(["RECEIVED", "QUEUED", "RUNNING", "EXECUTING"].concat(this.trackDoneStatus ? ["DONE"] : []));
			      this._limiter = null;
			      this.Events = new Events$4(this);
			      this._submitLock = new Sync$1("submit", this.Promise);
			      this._registerLock = new Sync$1("register", this.Promise);
			      storeOptions = parser$5.load(options, this.storeDefaults, {});
			      this._store = (function() {
			        if (this.datastore === "redis" || this.datastore === "ioredis" || (this.connection != null)) {
			          storeInstanceOptions = parser$5.load(options, this.redisStoreDefaults, {});
			          return new RedisDatastore$1(this, storeOptions, storeInstanceOptions);
			        } else if (this.datastore === "local") {
			          storeInstanceOptions = parser$5.load(options, this.localStoreDefaults, {});
			          return new LocalDatastore$1(this, storeOptions, storeInstanceOptions);
			        } else {
			          throw new Bottleneck.prototype.BottleneckError(`Invalid datastore type: ${this.datastore}`);
			        }
			      }).call(this);
			      this._queues.on("leftzero", () => {
			        var ref;
			        return (ref = this._store.heartbeat) != null ? typeof ref.ref === "function" ? ref.ref() : void 0 : void 0;
			      });
			      this._queues.on("zero", () => {
			        var ref;
			        return (ref = this._store.heartbeat) != null ? typeof ref.unref === "function" ? ref.unref() : void 0 : void 0;
			      });
			    }

			    _validateOptions(options, invalid) {
			      if (!((options != null) && typeof options === "object" && invalid.length === 0)) {
			        throw new Bottleneck.prototype.BottleneckError("Bottleneck v2 takes a single object argument. Refer to https://github.com/SGrondin/bottleneck#upgrading-to-v2 if you're upgrading from Bottleneck v1.");
			      }
			    }

			    ready() {
			      return this._store.ready;
			    }

			    clients() {
			      return this._store.clients;
			    }

			    channel() {
			      return `b_${this.id}`;
			    }

			    channel_client() {
			      return `b_${this.id}_${this._store.clientId}`;
			    }

			    publish(message) {
			      return this._store.__publish__(message);
			    }

			    disconnect(flush = true) {
			      return this._store.__disconnect__(flush);
			    }

			    chain(_limiter) {
			      this._limiter = _limiter;
			      return this;
			    }

			    queued(priority) {
			      return this._queues.queued(priority);
			    }

			    clusterQueued() {
			      return this._store.__queued__();
			    }

			    empty() {
			      return this.queued() === 0 && this._submitLock.isEmpty();
			    }

			    running() {
			      return this._store.__running__();
			    }

			    done() {
			      return this._store.__done__();
			    }

			    jobStatus(id) {
			      return this._states.jobStatus(id);
			    }

			    jobs(status) {
			      return this._states.statusJobs(status);
			    }

			    counts() {
			      return this._states.statusCounts();
			    }

			    _randomIndex() {
			      return Math.random().toString(36).slice(2);
			    }

			    check(weight = 1) {
			      return this._store.__check__(weight);
			    }

			    _clearGlobalState(index) {
			      if (this._scheduled[index] != null) {
			        clearTimeout(this._scheduled[index].expiration);
			        delete this._scheduled[index];
			        return true;
			      } else {
			        return false;
			      }
			    }

			    async _free(index, job, options, eventInfo) {
			      var e, running;
			      try {
			        ({running} = (await this._store.__free__(index, options.weight)));
			        this.Events.trigger("debug", `Freed ${options.id}`, eventInfo);
			        if (running === 0 && this.empty()) {
			          return this.Events.trigger("idle");
			        }
			      } catch (error1) {
			        e = error1;
			        return this.Events.trigger("error", e);
			      }
			    }

			    _run(index, job, wait) {
			      var clearGlobalState, free, run;
			      job.doRun();
			      clearGlobalState = this._clearGlobalState.bind(this, index);
			      run = this._run.bind(this, index, job);
			      free = this._free.bind(this, index, job);
			      return this._scheduled[index] = {
			        timeout: setTimeout(() => {
			          return job.doExecute(this._limiter, clearGlobalState, run, free);
			        }, wait),
			        expiration: job.options.expiration != null ? setTimeout(function() {
			          return job.doExpire(clearGlobalState, run, free);
			        }, wait + job.options.expiration) : void 0,
			        job: job
			      };
			    }

			    _drainOne(capacity) {
			      return this._registerLock.schedule(() => {
			        var args, index, next, options, queue;
			        if (this.queued() === 0) {
			          return this.Promise.resolve(null);
			        }
			        queue = this._queues.getFirst();
			        ({options, args} = next = queue.first());
			        if ((capacity != null) && options.weight > capacity) {
			          return this.Promise.resolve(null);
			        }
			        this.Events.trigger("debug", `Draining ${options.id}`, {args, options});
			        index = this._randomIndex();
			        return this._store.__register__(index, options.weight, options.expiration).then(({success, wait, reservoir}) => {
			          var empty;
			          this.Events.trigger("debug", `Drained ${options.id}`, {success, args, options});
			          if (success) {
			            queue.shift();
			            empty = this.empty();
			            if (empty) {
			              this.Events.trigger("empty");
			            }
			            if (reservoir === 0) {
			              this.Events.trigger("depleted", empty);
			            }
			            this._run(index, next, wait);
			            return this.Promise.resolve(options.weight);
			          } else {
			            return this.Promise.resolve(null);
			          }
			        });
			      });
			    }

			    _drainAll(capacity, total = 0) {
			      return this._drainOne(capacity).then((drained) => {
			        var newCapacity;
			        if (drained != null) {
			          newCapacity = capacity != null ? capacity - drained : capacity;
			          return this._drainAll(newCapacity, total + drained);
			        } else {
			          return this.Promise.resolve(total);
			        }
			      }).catch((e) => {
			        return this.Events.trigger("error", e);
			      });
			    }

			    _dropAllQueued(message) {
			      return this._queues.shiftAll(function(job) {
			        return job.doDrop({message});
			      });
			    }

			    stop(options = {}) {
			      var done, waitForExecuting;
			      options = parser$5.load(options, this.stopDefaults);
			      waitForExecuting = (at) => {
			        var finished;
			        finished = () => {
			          var counts;
			          counts = this._states.counts;
			          return (counts[0] + counts[1] + counts[2] + counts[3]) === at;
			        };
			        return new this.Promise((resolve, reject) => {
			          if (finished()) {
			            return resolve();
			          } else {
			            return this.on("done", () => {
			              if (finished()) {
			                this.removeAllListeners("done");
			                return resolve();
			              }
			            });
			          }
			        });
			      };
			      done = options.dropWaitingJobs ? (this._run = function(index, next) {
			        return next.doDrop({
			          message: options.dropErrorMessage
			        });
			      }, this._drainOne = () => {
			        return this.Promise.resolve(null);
			      }, this._registerLock.schedule(() => {
			        return this._submitLock.schedule(() => {
			          var k, ref, v;
			          ref = this._scheduled;
			          for (k in ref) {
			            v = ref[k];
			            if (this.jobStatus(v.job.options.id) === "RUNNING") {
			              clearTimeout(v.timeout);
			              clearTimeout(v.expiration);
			              v.job.doDrop({
			                message: options.dropErrorMessage
			              });
			            }
			          }
			          this._dropAllQueued(options.dropErrorMessage);
			          return waitForExecuting(0);
			        });
			      })) : this.schedule({
			        priority: NUM_PRIORITIES$1 - 1,
			        weight: 0
			      }, () => {
			        return waitForExecuting(1);
			      });
			      this._receive = function(job) {
			        return job._reject(new Bottleneck.prototype.BottleneckError(options.enqueueErrorMessage));
			      };
			      this.stop = () => {
			        return this.Promise.reject(new Bottleneck.prototype.BottleneckError("stop() has already been called"));
			      };
			      return done;
			    }

			    async _addToQueue(job) {
			      var args, blocked, error, options, reachedHWM, shifted, strategy;
			      ({args, options} = job);
			      try {
			        ({reachedHWM, blocked, strategy} = (await this._store.__submit__(this.queued(), options.weight)));
			      } catch (error1) {
			        error = error1;
			        this.Events.trigger("debug", `Could not queue ${options.id}`, {args, options, error});
			        job.doDrop({error});
			        return false;
			      }
			      if (blocked) {
			        job.doDrop();
			        return true;
			      } else if (reachedHWM) {
			        shifted = strategy === Bottleneck.prototype.strategy.LEAK ? this._queues.shiftLastFrom(options.priority) : strategy === Bottleneck.prototype.strategy.OVERFLOW_PRIORITY ? this._queues.shiftLastFrom(options.priority + 1) : strategy === Bottleneck.prototype.strategy.OVERFLOW ? job : void 0;
			        if (shifted != null) {
			          shifted.doDrop();
			        }
			        if ((shifted == null) || strategy === Bottleneck.prototype.strategy.OVERFLOW) {
			          if (shifted == null) {
			            job.doDrop();
			          }
			          return reachedHWM;
			        }
			      }
			      job.doQueue(reachedHWM, blocked);
			      this._queues.push(job);
			      await this._drainAll();
			      return reachedHWM;
			    }

			    _receive(job) {
			      if (this._states.jobStatus(job.options.id) != null) {
			        job._reject(new Bottleneck.prototype.BottleneckError(`A job with the same id already exists (id=${job.options.id})`));
			        return false;
			      } else {
			        job.doReceive();
			        return this._submitLock.schedule(this._addToQueue, job);
			      }
			    }

			    submit(...args) {
			      var cb, fn, job, options, ref, ref1, task;
			      if (typeof args[0] === "function") {
			        ref = args, [fn, ...args] = ref, [cb] = splice.call(args, -1);
			        options = parser$5.load({}, this.jobDefaults);
			      } else {
			        ref1 = args, [options, fn, ...args] = ref1, [cb] = splice.call(args, -1);
			        options = parser$5.load(options, this.jobDefaults);
			      }
			      task = (...args) => {
			        return new this.Promise(function(resolve, reject) {
			          return fn(...args, function(...args) {
			            return (args[0] != null ? reject : resolve)(args);
			          });
			        });
			      };
			      job = new Job$1(task, args, options, this.jobDefaults, this.rejectOnDrop, this.Events, this._states, this.Promise);
			      job.promise.then(function(args) {
			        return typeof cb === "function" ? cb(...args) : void 0;
			      }).catch(function(args) {
			        if (Array.isArray(args)) {
			          return typeof cb === "function" ? cb(...args) : void 0;
			        } else {
			          return typeof cb === "function" ? cb(args) : void 0;
			        }
			      });
			      return this._receive(job);
			    }

			    schedule(...args) {
			      var job, options, task;
			      if (typeof args[0] === "function") {
			        [task, ...args] = args;
			        options = {};
			      } else {
			        [options, task, ...args] = args;
			      }
			      job = new Job$1(task, args, options, this.jobDefaults, this.rejectOnDrop, this.Events, this._states, this.Promise);
			      this._receive(job);
			      return job.promise;
			    }

			    wrap(fn) {
			      var schedule, wrapped;
			      schedule = this.schedule.bind(this);
			      wrapped = function(...args) {
			        return schedule(fn.bind(this), ...args);
			      };
			      wrapped.withOptions = function(options, ...args) {
			        return schedule(options, fn, ...args);
			      };
			      return wrapped;
			    }

			    async updateSettings(options = {}) {
			      await this._store.__updateSettings__(parser$5.overwrite(options, this.storeDefaults));
			      parser$5.overwrite(options, this.instanceDefaults, this);
			      return this;
			    }

			    currentReservoir() {
			      return this._store.__currentReservoir__();
			    }

			    incrementReservoir(incr = 0) {
			      return this._store.__incrementReservoir__(incr);
			    }

			  }
			  Bottleneck.default = Bottleneck;

			  Bottleneck.Events = Events$4;

			  Bottleneck.version = Bottleneck.prototype.version = require$$8.version;

			  Bottleneck.strategy = Bottleneck.prototype.strategy = {
			    LEAK: 1,
			    OVERFLOW: 2,
			    OVERFLOW_PRIORITY: 4,
			    BLOCK: 3
			  };

			  Bottleneck.BottleneckError = Bottleneck.prototype.BottleneckError = BottleneckError_1;

			  Bottleneck.Group = Bottleneck.prototype.Group = Group_1;

			  Bottleneck.RedisConnection = Bottleneck.prototype.RedisConnection = require$$2;

			  Bottleneck.IORedisConnection = Bottleneck.prototype.IORedisConnection = require$$3;

			  Bottleneck.Batcher = Bottleneck.prototype.Batcher = Batcher_1;

			  Bottleneck.prototype.jobDefaults = {
			    priority: DEFAULT_PRIORITY$1,
			    weight: 1,
			    expiration: null,
			    id: "<no-id>"
			  };

			  Bottleneck.prototype.storeDefaults = {
			    maxConcurrent: null,
			    minTime: 0,
			    highWater: null,
			    strategy: Bottleneck.prototype.strategy.LEAK,
			    penalty: null,
			    reservoir: null,
			    reservoirRefreshInterval: null,
			    reservoirRefreshAmount: null,
			    reservoirIncreaseInterval: null,
			    reservoirIncreaseAmount: null,
			    reservoirIncreaseMaximum: null
			  };

			  Bottleneck.prototype.localStoreDefaults = {
			    Promise: Promise,
			    timeout: null,
			    heartbeatInterval: 250
			  };

			  Bottleneck.prototype.redisStoreDefaults = {
			    Promise: Promise,
			    timeout: null,
			    heartbeatInterval: 5000,
			    clientTimeout: 10000,
			    Redis: null,
			    clientOptions: {},
			    clusterNodes: null,
			    clearDatastore: false,
			    connection: null
			  };

			  Bottleneck.prototype.instanceDefaults = {
			    datastore: "local",
			    connection: null,
			    id: "<no-id>",
			    rejectOnDrop: true,
			    trackDoneStatus: false,
			    Promise: Promise
			  };

			  Bottleneck.prototype.stopDefaults = {
			    enqueueErrorMessage: "This limiter has been stopped and cannot accept new jobs.",
			    dropWaitingJobs: true,
			    dropErrorMessage: "This limiter has been stopped."
			  };

			  return Bottleneck;

			}).call(commonjsGlobal$1);

			var Bottleneck_1 = Bottleneck;

			var lib = Bottleneck_1;

			return lib;

		}))); 
	} (light$1));
	return light$1.exports;
}

var lightExports = requireLight();
var BottleneckLight = /*@__PURE__*/getDefaultExportFromCjs(lightExports);

// pkg/dist-src/index.js

// pkg/dist-src/version.js
var VERSION$8 = "0.0.0-development";

// pkg/dist-src/wrap-request.js
var noop$2 = () => Promise.resolve();
function wrapRequest(state, request, options) {
  return state.retryLimiter.schedule(doRequest, state, request, options);
}
async function doRequest(state, request, options) {
  const { pathname } = new URL(options.url, "http://github.test");
  const isAuth = isAuthRequest(options.method, pathname);
  const isWrite = !isAuth && options.method !== "GET" && options.method !== "HEAD";
  const isSearch = options.method === "GET" && pathname.startsWith("/search/");
  const isGraphQL = pathname.startsWith("/graphql");
  const retryCount = ~~request.retryCount;
  const jobOptions = retryCount > 0 ? { priority: 0, weight: 0 } : {};
  if (state.clustering) {
    jobOptions.expiration = 1e3 * 60;
  }
  if (isWrite || isGraphQL) {
    await state.write.key(state.id).schedule(jobOptions, noop$2);
  }
  if (isWrite && state.triggersNotification(pathname)) {
    await state.notifications.key(state.id).schedule(jobOptions, noop$2);
  }
  if (isSearch) {
    await state.search.key(state.id).schedule(jobOptions, noop$2);
  }
  const req = (isAuth ? state.auth : state.global).key(state.id).schedule(jobOptions, request, options);
  if (isGraphQL) {
    const res = await req;
    if (res.data.errors != null && res.data.errors.some((error) => error.type === "RATE_LIMITED")) {
      const error = Object.assign(new Error("GraphQL Rate Limit Exceeded"), {
        response: res,
        data: res.data
      });
      throw error;
    }
  }
  return req;
}
function isAuthRequest(method, pathname) {
  return method === "PATCH" && // https://docs.github.com/en/rest/apps/apps?apiVersion=2022-11-28#create-a-scoped-access-token
  /^\/applications\/[^/]+\/token\/scoped$/.test(pathname) || method === "POST" && // https://docs.github.com/en/rest/apps/oauth-applications?apiVersion=2022-11-28#reset-a-token
  (/^\/applications\/[^/]+\/token$/.test(pathname) || // https://docs.github.com/en/rest/apps/apps?apiVersion=2022-11-28#create-an-installation-access-token-for-an-app
  /^\/app\/installations\/[^/]+\/access_tokens$/.test(pathname) || // https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
  pathname === "/login/oauth/access_token");
}

// pkg/dist-src/generated/triggers-notification-paths.js
var triggers_notification_paths_default = [
  "/orgs/{org}/invitations",
  "/orgs/{org}/invitations/{invitation_id}",
  "/orgs/{org}/teams/{team_slug}/discussions",
  "/orgs/{org}/teams/{team_slug}/discussions/{discussion_number}/comments",
  "/repos/{owner}/{repo}/collaborators/{username}",
  "/repos/{owner}/{repo}/commits/{commit_sha}/comments",
  "/repos/{owner}/{repo}/issues",
  "/repos/{owner}/{repo}/issues/{issue_number}/comments",
  "/repos/{owner}/{repo}/issues/{issue_number}/sub_issue",
  "/repos/{owner}/{repo}/issues/{issue_number}/sub_issues/priority",
  "/repos/{owner}/{repo}/pulls",
  "/repos/{owner}/{repo}/pulls/{pull_number}/comments",
  "/repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies",
  "/repos/{owner}/{repo}/pulls/{pull_number}/merge",
  "/repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
  "/repos/{owner}/{repo}/pulls/{pull_number}/reviews",
  "/repos/{owner}/{repo}/releases",
  "/teams/{team_id}/discussions",
  "/teams/{team_id}/discussions/{discussion_number}/comments"
];

// pkg/dist-src/route-matcher.js
function routeMatcher(paths) {
  const regexes = paths.map(
    (path) => path.split("/").map((c) => c.startsWith("{") ? "(?:.+?)" : c).join("/")
  );
  const regex2 = `^(?:${regexes.map((r) => `(?:${r})`).join("|")})[^/]*$`;
  return new RegExp(regex2, "i");
}

// pkg/dist-src/index.js
var regex = routeMatcher(triggers_notification_paths_default);
var triggersNotification = regex.test.bind(regex);
var groups = {};
var createGroups = function(Bottleneck, common) {
  groups.global = new Bottleneck.Group({
    id: "octokit-global",
    maxConcurrent: 10,
    ...common
  });
  groups.auth = new Bottleneck.Group({
    id: "octokit-auth",
    maxConcurrent: 1,
    ...common
  });
  groups.search = new Bottleneck.Group({
    id: "octokit-search",
    maxConcurrent: 1,
    minTime: 2e3,
    ...common
  });
  groups.write = new Bottleneck.Group({
    id: "octokit-write",
    maxConcurrent: 1,
    minTime: 1e3,
    ...common
  });
  groups.notifications = new Bottleneck.Group({
    id: "octokit-notifications",
    maxConcurrent: 1,
    minTime: 3e3,
    ...common
  });
};
function throttling(octokit, octokitOptions) {
  const {
    enabled = true,
    Bottleneck = BottleneckLight,
    id = "no-id",
    timeout = 1e3 * 60 * 2,
    // Redis TTL: 2 minutes
    connection
  } = octokitOptions.throttle || {};
  if (!enabled) {
    return {};
  }
  const common = { timeout };
  if (typeof connection !== "undefined") {
    common.connection = connection;
  }
  const state = Object.assign(
    {
      clustering: connection != null,
      triggersNotification,
      fallbackSecondaryRateRetryAfter: 60,
      retryAfterBaseValue: 1e3,
      id
    },
    octokitOptions.throttle
  );
  if (typeof state.onSecondaryRateLimit !== "function" || typeof state.onRateLimit !== "function") {
    throw new Error(`octokit/plugin-throttling error:
        You must pass the onSecondaryRateLimit and onRateLimit error handlers.
        See https://octokit.github.io/rest.js/#throttling

        const octokit = new Octokit({
          throttle: {
            onSecondaryRateLimit: (retryAfter, options) => {/* ... */},
            onRateLimit: (retryAfter, options) => {/* ... */}
          }
        })
    `);
  }
  let initialized = false;
  const initializeBottleneck = () => {
    if (initialized) {
      return;
    }
    initialized = true;
    if (groups.global == null) {
      createGroups(Bottleneck, common);
    }
    state.global = state.global ?? groups.global;
    state.auth = state.auth ?? groups.auth;
    state.search = state.search ?? groups.search;
    state.write = state.write ?? groups.write;
    state.notifications = state.notifications ?? groups.notifications;
    state.retryLimiter = state.retryLimiter ?? new Bottleneck();
    const events = {};
    const emitter = new Bottleneck.Events(events);
    events.on("secondary-limit", state.onSecondaryRateLimit);
    events.on("rate-limit", state.onRateLimit);
    events.on(
      "error",
      (e) => octokit.log.warn("Error in throttling-plugin limit handler", e)
    );
    state.retryLimiter.on("failed", async function(error, info) {
      const [state2, request, options] = info.args;
      const { pathname } = new URL(options.url, "http://github.test");
      const shouldRetryGraphQL = pathname.startsWith("/graphql") && error.status !== 401;
      if (!(shouldRetryGraphQL || error.status === 403 || error.status === 429)) {
        return;
      }
      const retryCount = ~~request.retryCount;
      request.retryCount = retryCount;
      options.request.retryCount = retryCount;
      const { wantRetry, retryAfter = 0 } = await (async function() {
        if (/\bsecondary rate\b/i.test(error.message)) {
          const retryAfter2 = Number(error.response.headers["retry-after"]) || state2.fallbackSecondaryRateRetryAfter;
          const wantRetry2 = await emitter.trigger(
            "secondary-limit",
            retryAfter2,
            options,
            octokit,
            retryCount
          );
          return { wantRetry: wantRetry2, retryAfter: retryAfter2 };
        }
        if (error.response.headers != null && error.response.headers["x-ratelimit-remaining"] === "0" || (error.response.data?.errors ?? []).some(
          (error2) => error2.type === "RATE_LIMITED"
        )) {
          const rateLimitReset = new Date(
            ~~error.response.headers["x-ratelimit-reset"] * 1e3
          ).getTime();
          const retryAfter2 = Math.max(
            // Add one second so we retry _after_ the reset time
            // https://docs.github.com/en/rest/overview/resources-in-the-rest-api?apiVersion=2022-11-28#exceeding-the-rate-limit
            Math.ceil((rateLimitReset - Date.now()) / 1e3) + 1,
            0
          );
          const wantRetry2 = await emitter.trigger(
            "rate-limit",
            retryAfter2,
            options,
            octokit,
            retryCount
          );
          return { wantRetry: wantRetry2, retryAfter: retryAfter2 };
        }
        return {};
      })();
      if (wantRetry) {
        request.retryCount++;
        return retryAfter * state2.retryAfterBaseValue;
      }
    });
  };
  octokit.hook.wrap("request", (request, options) => {
    initializeBottleneck();
    return wrapRequest(state, request, options);
  });
  return {};
}
throttling.VERSION = VERSION$8;
throttling.triggersNotification = triggersNotification;

function getUserAgent() {
  if (typeof navigator === "object" && "userAgent" in navigator) {
    return navigator.userAgent;
  }

  if (typeof process === "object" && process.version !== undefined) {
    return `Node.js/${process.version.substr(1)} (${process.platform}; ${
      process.arch
    })`;
  }

  return "<environment undetectable>";
}

// @ts-check

function register(state, name, method, options) {
  if (typeof method !== "function") {
    throw new Error("method for before hook must be a function");
  }

  if (!options) {
    options = {};
  }

  if (Array.isArray(name)) {
    return name.reverse().reduce((callback, name) => {
      return register.bind(null, state, name, callback, options);
    }, method)();
  }

  return Promise.resolve().then(() => {
    if (!state.registry[name]) {
      return method(options);
    }

    return state.registry[name].reduce((method, registered) => {
      return registered.hook.bind(null, method, options);
    }, method)();
  });
}

// @ts-check

function addHook(state, kind, name, hook) {
  const orig = hook;
  if (!state.registry[name]) {
    state.registry[name] = [];
  }

  if (kind === "before") {
    hook = (method, options) => {
      return Promise.resolve()
        .then(orig.bind(null, options))
        .then(method.bind(null, options));
    };
  }

  if (kind === "after") {
    hook = (method, options) => {
      let result;
      return Promise.resolve()
        .then(method.bind(null, options))
        .then((result_) => {
          result = result_;
          return orig(result, options);
        })
        .then(() => {
          return result;
        });
    };
  }

  if (kind === "error") {
    hook = (method, options) => {
      return Promise.resolve()
        .then(method.bind(null, options))
        .catch((error) => {
          return orig(error, options);
        });
    };
  }

  state.registry[name].push({
    hook: hook,
    orig: orig,
  });
}

// @ts-check

function removeHook(state, name, method) {
  if (!state.registry[name]) {
    return;
  }

  const index = state.registry[name]
    .map((registered) => {
      return registered.orig;
    })
    .indexOf(method);

  if (index === -1) {
    return;
  }

  state.registry[name].splice(index, 1);
}

// @ts-check


// bind with array of arguments: https://stackoverflow.com/a/21792913
const bind = Function.bind;
const bindable = bind.bind(bind);

function bindApi(hook, state, name) {
  const removeHookRef = bindable(removeHook, null).apply(
    null,
    [state]
  );
  hook.api = { remove: removeHookRef };
  hook.remove = removeHookRef;
  ["before", "error", "after", "wrap"].forEach((kind) => {
    const args = [state, kind];
    hook[kind] = hook.api[kind] = bindable(addHook, null).apply(null, args);
  });
}

function Collection() {
  const state = {
    registry: {},
  };

  const hook = register.bind(null, state);
  bindApi(hook, state);

  return hook;
}

var Hook = { Collection };

// pkg/dist-src/defaults.js

// pkg/dist-src/version.js
var VERSION$7 = "0.0.0-development";

// pkg/dist-src/defaults.js
var userAgent = `octokit-endpoint.js/${VERSION$7} ${getUserAgent()}`;
var DEFAULTS = {
  method: "GET",
  baseUrl: "https://api.github.com",
  headers: {
    accept: "application/vnd.github.v3+json",
    "user-agent": userAgent
  },
  mediaType: {
    format: ""
  }
};

// pkg/dist-src/util/lowercase-keys.js
function lowercaseKeys(object) {
  if (!object) {
    return {};
  }
  return Object.keys(object).reduce((newObj, key) => {
    newObj[key.toLowerCase()] = object[key];
    return newObj;
  }, {});
}

// pkg/dist-src/util/is-plain-object.js
function isPlainObject$1(value) {
  if (typeof value !== "object" || value === null) return false;
  if (Object.prototype.toString.call(value) !== "[object Object]") return false;
  const proto = Object.getPrototypeOf(value);
  if (proto === null) return true;
  const Ctor = Object.prototype.hasOwnProperty.call(proto, "constructor") && proto.constructor;
  return typeof Ctor === "function" && Ctor instanceof Ctor && Function.prototype.call(Ctor) === Function.prototype.call(value);
}

// pkg/dist-src/util/merge-deep.js
function mergeDeep(defaults, options) {
  const result = Object.assign({}, defaults);
  Object.keys(options).forEach((key) => {
    if (isPlainObject$1(options[key])) {
      if (!(key in defaults)) Object.assign(result, { [key]: options[key] });
      else result[key] = mergeDeep(defaults[key], options[key]);
    } else {
      Object.assign(result, { [key]: options[key] });
    }
  });
  return result;
}

// pkg/dist-src/util/remove-undefined-properties.js
function removeUndefinedProperties(obj) {
  for (const key in obj) {
    if (obj[key] === void 0) {
      delete obj[key];
    }
  }
  return obj;
}

// pkg/dist-src/merge.js
function merge(defaults, route, options) {
  if (typeof route === "string") {
    let [method, url] = route.split(" ");
    options = Object.assign(url ? { method, url } : { url: method }, options);
  } else {
    options = Object.assign({}, route);
  }
  options.headers = lowercaseKeys(options.headers);
  removeUndefinedProperties(options);
  removeUndefinedProperties(options.headers);
  const mergedOptions = mergeDeep(defaults || {}, options);
  if (options.url === "/graphql") {
    if (defaults && defaults.mediaType.previews?.length) {
      mergedOptions.mediaType.previews = defaults.mediaType.previews.filter(
        (preview) => !mergedOptions.mediaType.previews.includes(preview)
      ).concat(mergedOptions.mediaType.previews);
    }
    mergedOptions.mediaType.previews = (mergedOptions.mediaType.previews || []).map((preview) => preview.replace(/-preview/, ""));
  }
  return mergedOptions;
}

// pkg/dist-src/util/add-query-parameters.js
function addQueryParameters(url, parameters) {
  const separator = /\?/.test(url) ? "&" : "?";
  const names = Object.keys(parameters);
  if (names.length === 0) {
    return url;
  }
  return url + separator + names.map((name) => {
    if (name === "q") {
      return "q=" + parameters.q.split("+").map(encodeURIComponent).join("+");
    }
    return `${name}=${encodeURIComponent(parameters[name])}`;
  }).join("&");
}

// pkg/dist-src/util/extract-url-variable-names.js
var urlVariableRegex = /\{[^{}}]+\}/g;
function removeNonChars(variableName) {
  return variableName.replace(/(?:^\W+)|(?:(?<!\W)\W+$)/g, "").split(/,/);
}
function extractUrlVariableNames(url) {
  const matches = url.match(urlVariableRegex);
  if (!matches) {
    return [];
  }
  return matches.map(removeNonChars).reduce((a, b) => a.concat(b), []);
}

// pkg/dist-src/util/omit.js
function omit(object, keysToOmit) {
  const result = { __proto__: null };
  for (const key of Object.keys(object)) {
    if (keysToOmit.indexOf(key) === -1) {
      result[key] = object[key];
    }
  }
  return result;
}

// pkg/dist-src/util/url-template.js
function encodeReserved(str) {
  return str.split(/(%[0-9A-Fa-f]{2})/g).map(function(part) {
    if (!/%[0-9A-Fa-f]/.test(part)) {
      part = encodeURI(part).replace(/%5B/g, "[").replace(/%5D/g, "]");
    }
    return part;
  }).join("");
}
function encodeUnreserved(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, function(c) {
    return "%" + c.charCodeAt(0).toString(16).toUpperCase();
  });
}
function encodeValue(operator, value, key) {
  value = operator === "+" || operator === "#" ? encodeReserved(value) : encodeUnreserved(value);
  if (key) {
    return encodeUnreserved(key) + "=" + value;
  } else {
    return value;
  }
}
function isDefined(value) {
  return value !== void 0 && value !== null;
}
function isKeyOperator(operator) {
  return operator === ";" || operator === "&" || operator === "?";
}
function getValues(context, operator, key, modifier) {
  var value = context[key], result = [];
  if (isDefined(value) && value !== "") {
    if (typeof value === "string" || typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
      value = value.toString();
      if (modifier && modifier !== "*") {
        value = value.substring(0, parseInt(modifier, 10));
      }
      result.push(
        encodeValue(operator, value, isKeyOperator(operator) ? key : "")
      );
    } else {
      if (modifier === "*") {
        if (Array.isArray(value)) {
          value.filter(isDefined).forEach(function(value2) {
            result.push(
              encodeValue(operator, value2, isKeyOperator(operator) ? key : "")
            );
          });
        } else {
          Object.keys(value).forEach(function(k) {
            if (isDefined(value[k])) {
              result.push(encodeValue(operator, value[k], k));
            }
          });
        }
      } else {
        const tmp = [];
        if (Array.isArray(value)) {
          value.filter(isDefined).forEach(function(value2) {
            tmp.push(encodeValue(operator, value2));
          });
        } else {
          Object.keys(value).forEach(function(k) {
            if (isDefined(value[k])) {
              tmp.push(encodeUnreserved(k));
              tmp.push(encodeValue(operator, value[k].toString()));
            }
          });
        }
        if (isKeyOperator(operator)) {
          result.push(encodeUnreserved(key) + "=" + tmp.join(","));
        } else if (tmp.length !== 0) {
          result.push(tmp.join(","));
        }
      }
    }
  } else {
    if (operator === ";") {
      if (isDefined(value)) {
        result.push(encodeUnreserved(key));
      }
    } else if (value === "" && (operator === "&" || operator === "?")) {
      result.push(encodeUnreserved(key) + "=");
    } else if (value === "") {
      result.push("");
    }
  }
  return result;
}
function parseUrl(template) {
  return {
    expand: expand.bind(null, template)
  };
}
function expand(template, context) {
  var operators = ["+", "#", ".", "/", ";", "?", "&"];
  template = template.replace(
    /\{([^\{\}]+)\}|([^\{\}]+)/g,
    function(_, expression, literal) {
      if (expression) {
        let operator = "";
        const values = [];
        if (operators.indexOf(expression.charAt(0)) !== -1) {
          operator = expression.charAt(0);
          expression = expression.substr(1);
        }
        expression.split(/,/g).forEach(function(variable) {
          var tmp = /([^:\*]*)(?::(\d+)|(\*))?/.exec(variable);
          values.push(getValues(context, operator, tmp[1], tmp[2] || tmp[3]));
        });
        if (operator && operator !== "+") {
          var separator = ",";
          if (operator === "?") {
            separator = "&";
          } else if (operator !== "#") {
            separator = operator;
          }
          return (values.length !== 0 ? operator : "") + values.join(separator);
        } else {
          return values.join(",");
        }
      } else {
        return encodeReserved(literal);
      }
    }
  );
  if (template === "/") {
    return template;
  } else {
    return template.replace(/\/$/, "");
  }
}

// pkg/dist-src/parse.js
function parse$1(options) {
  let method = options.method.toUpperCase();
  let url = (options.url || "/").replace(/:([a-z]\w+)/g, "{$1}");
  let headers = Object.assign({}, options.headers);
  let body;
  let parameters = omit(options, [
    "method",
    "baseUrl",
    "url",
    "headers",
    "request",
    "mediaType"
  ]);
  const urlVariableNames = extractUrlVariableNames(url);
  url = parseUrl(url).expand(parameters);
  if (!/^http/.test(url)) {
    url = options.baseUrl + url;
  }
  const omittedParameters = Object.keys(options).filter((option) => urlVariableNames.includes(option)).concat("baseUrl");
  const remainingParameters = omit(parameters, omittedParameters);
  const isBinaryRequest = /application\/octet-stream/i.test(headers.accept);
  if (!isBinaryRequest) {
    if (options.mediaType.format) {
      headers.accept = headers.accept.split(/,/).map(
        (format) => format.replace(
          /application\/vnd(\.\w+)(\.v3)?(\.\w+)?(\+json)?$/,
          `application/vnd$1$2.${options.mediaType.format}`
        )
      ).join(",");
    }
    if (url.endsWith("/graphql")) {
      if (options.mediaType.previews?.length) {
        const previewsFromAcceptHeader = headers.accept.match(/(?<![\w-])[\w-]+(?=-preview)/g) || [];
        headers.accept = previewsFromAcceptHeader.concat(options.mediaType.previews).map((preview) => {
          const format = options.mediaType.format ? `.${options.mediaType.format}` : "+json";
          return `application/vnd.github.${preview}-preview${format}`;
        }).join(",");
      }
    }
  }
  if (["GET", "HEAD"].includes(method)) {
    url = addQueryParameters(url, remainingParameters);
  } else {
    if ("data" in remainingParameters) {
      body = remainingParameters.data;
    } else {
      if (Object.keys(remainingParameters).length) {
        body = remainingParameters;
      }
    }
  }
  if (!headers["content-type"] && typeof body !== "undefined") {
    headers["content-type"] = "application/json; charset=utf-8";
  }
  if (["PATCH", "PUT"].includes(method) && typeof body === "undefined") {
    body = "";
  }
  return Object.assign(
    { method, url, headers },
    typeof body !== "undefined" ? { body } : null,
    options.request ? { request: options.request } : null
  );
}

// pkg/dist-src/endpoint-with-defaults.js
function endpointWithDefaults(defaults, route, options) {
  return parse$1(merge(defaults, route, options));
}

// pkg/dist-src/with-defaults.js
function withDefaults$2(oldDefaults, newDefaults) {
  const DEFAULTS2 = merge(oldDefaults, newDefaults);
  const endpoint2 = endpointWithDefaults.bind(null, DEFAULTS2);
  return Object.assign(endpoint2, {
    DEFAULTS: DEFAULTS2,
    defaults: withDefaults$2.bind(null, DEFAULTS2),
    merge: merge.bind(null, DEFAULTS2),
    parse: parse$1
  });
}

// pkg/dist-src/index.js
var endpoint = withDefaults$2(null, DEFAULTS);

/*!
 * content-type
 * Copyright(c) 2015 Douglas Christopher Wilson
 * MIT Licensed
 */
const SP = 32; // " "
const HTAB = 9; // "\t"
const SEMI = 59; // ";"
const EQ = 61; // "="
const DQUOTE = 34; // '"'
const BSLASH = 92; // "\\"
const COMMA = 44; // ","
const LOWER_CASE = 1;
const OWS = 2;
const SEMI_FLAG = 4;
const COMMA_FLAG = 8;
const TOKEN_FLAG = 16;
const NON_ASCII = 0xff00;
const CASE_FLAGS = LOWER_CASE | NON_ASCII;
/**
 * Character flags used to normalize HTTP field values while scanning.
 * Out-of-range reads intentionally coerce to zero in bitwise expressions.
 */
const CHAR_MAP = new Uint8Array(0x100);
CHAR_MAP[HTAB] |= OWS;
CHAR_MAP[SP] |= OWS;
CHAR_MAP[SEMI] |= SEMI_FLAG;
CHAR_MAP[COMMA] |= COMMA_FLAG;
for (let code = 0x80 /* non-ASCII */; code <= 0xff; code++) {
    CHAR_MAP[code] |= LOWER_CASE;
}
for (const char of "!#$%&'*+-.^_`|~") {
    CHAR_MAP[char.charCodeAt(0)] |= TOKEN_FLAG;
}
for (let code = 0x30 /* 0 */; code <= 0x39 /* 9 */; code++) {
    CHAR_MAP[code] |= TOKEN_FLAG;
}
for (let code = 0x41 /* A */; code <= 0x5a /* Z */; code++) {
    CHAR_MAP[code] |= LOWER_CASE | TOKEN_FLAG;
}
for (let code = 0x61 /* a */; code <= 0x7a /* z */; code++) {
    CHAR_MAP[code] |= TOKEN_FLAG;
}
/**
 * Null object perf optimization. Faster than `Object.create(null)` and `{ __proto__: null }`.
 */
const NullObject = /* @__PURE__ */ (() => {
    const C = function () { };
    C.prototype = Object.create(null);
    return C;
})();
/**
 * Parse a `Content-Type` header.
 */
function parse(header, options) {
    const stopFlags = SEMI_FLAG | (0);
    const len = header.length;
    let valueStart = 0;
    while ((CHAR_MAP[header.charCodeAt(valueStart)] & OWS) !== 0) {
        valueStart++;
    }
    let index = valueStart;
    let typeFlags = 0;
    let whitespace = -1;
    let stop = 0;
    while (index < len) {
        const code = header.charCodeAt(index);
        const flags = CHAR_MAP[code];
        if ((flags & stopFlags) !== 0) {
            stop |= flags & COMMA_FLAG;
            break;
        }
        if ((flags & OWS) !== 0) {
            if (whitespace === -1)
                whitespace = index;
        }
        else {
            whitespace = -1;
        }
        typeFlags |= (code & NON_ASCII) | flags;
        index++;
    }
    const valueEnd = whitespace === -1 ? index : whitespace;
    const value = header.slice(valueStart, valueEnd);
    const type = (typeFlags & CASE_FLAGS) === 0 ? value : value.toLowerCase();
    if (index === len || stop !== 0) {
        return { type, index, parameters: new NullObject() };
    }
    return parseParameters(header, type, index, len, stopFlags);
}
/**
 * Parses the parameters of a `Content-Type` header starting at the given index.
 */
function parseParameters(header, type, index, len, stopFlags) {
    const parameters = new NullObject();
    parameter: while (index < len) {
        index++; // Skip over ;
        while ((CHAR_MAP[header.charCodeAt(index)] & OWS) !== 0) {
            index++;
        }
        const keyStart = index;
        let keyFlags = 0;
        let keyWhitespace = -1;
        while (index < len) {
            const code = header.charCodeAt(index);
            const flags = CHAR_MAP[code];
            if ((flags & stopFlags) !== 0) {
                if ((flags & COMMA_FLAG) !== 0)
                    break parameter;
                continue parameter;
            }
            if (code === EQ) {
                const keyEnd = keyWhitespace === -1 ? index : keyWhitespace;
                const value = header.slice(keyStart, keyEnd);
                const key = (keyFlags & CASE_FLAGS) === 0 ? value : value.toLowerCase();
                index++;
                while ((CHAR_MAP[header.charCodeAt(index)] & OWS) !== 0) {
                    index++;
                }
                if (index < len && header.charCodeAt(index) === DQUOTE) {
                    const quotedStart = ++index;
                    let escaped = false;
                    while (index < len) {
                        const code = header.charCodeAt(index);
                        if (code === DQUOTE) {
                            if (parameters[key] === undefined) {
                                parameters[key] = escaped
                                    ? unescapeQuotedPairs(header, quotedStart, index)
                                    : header.slice(quotedStart, index);
                            }
                            index++;
                            let stop = 0;
                            // Discard characters between quote and delimiter.
                            while (index < len) {
                                const code = header.charCodeAt(index);
                                const flags = CHAR_MAP[code];
                                if ((flags & stopFlags) !== 0) {
                                    stop = flags & COMMA_FLAG;
                                    break;
                                }
                                index++;
                            }
                            if (stop !== 0)
                                break parameter;
                            continue parameter;
                        }
                        if (code === BSLASH && index + 1 < len) {
                            escaped = true;
                            index += 2;
                            continue;
                        }
                        index++;
                    }
                    continue parameter;
                }
                const valueStart = index;
                let stop = 0;
                let valueWhitespace = -1;
                while (index < len) {
                    const code = header.charCodeAt(index);
                    const flags = CHAR_MAP[code];
                    if ((flags & stopFlags) !== 0) {
                        stop = flags & COMMA_FLAG;
                        break;
                    }
                    if ((flags & OWS) !== 0) {
                        if (valueWhitespace === -1)
                            valueWhitespace = index;
                    }
                    else {
                        valueWhitespace = -1;
                    }
                    index++;
                }
                if (parameters[key] === undefined) {
                    const valueEnd = valueWhitespace === -1 ? index : valueWhitespace;
                    parameters[key] = header.slice(valueStart, valueEnd);
                }
                if (stop !== 0)
                    break parameter;
                continue parameter;
            }
            if ((flags & OWS) !== 0) {
                if (keyWhitespace === -1)
                    keyWhitespace = index;
            }
            else {
                keyWhitespace = -1;
            }
            keyFlags |= (code & NON_ASCII) | flags;
            index++;
        }
    }
    return { type, index, parameters };
}
/**
 * Remove backslashes from quoted pairs in a known-terminated quoted string body.
 */
function unescapeQuotedPairs(str, start, end) {
    let result = "";
    for (let index = start; index < end; index++) {
        if (str.charCodeAt(index) === BSLASH) {
            result += str.slice(start, index);
            start = ++index;
        }
    }
    return result + str.slice(start, end);
}

const intRegex = /^-?\d+$/;
const noiseValue = /^-?\d+n+$/; // Noise - strings that match the custom format before being converted to it
const originalStringify = JSON.stringify;
const originalParse = JSON.parse;
const customFormat = /^-?\d+n$/;

const bigIntsStringify = /([\[:])?"(-?\d+)n"($|\s*[,\}\]])/g;
const noiseStringify = /([\[:])?("-?\d+n+)n("$|"\s*[,\}\]])/g;

/**
 * @typedef {(this: any, key: string | number | undefined, value: any) => any} Replacer
 * @typedef {(key: string | number | undefined, value: any, context?: { source: string }) => any} Reviver
 */

/**
 * Checks if a value is unstringifiable according to native JSON.stringify rules.
 *
 * @param {any} val The value to check.
 * @returns {boolean} True if the value is undefined, a function, or a symbol.
 */
const isUnstringifiable = (val) =>
  val === undefined || typeof val === "function" || typeof val === "symbol";

/**
 * Checks if a value is a native JSON.rawJSON object (Node.js 22+).
 *
 * @param {any} val The value to check.
 * @returns {boolean} True if the value is a RawJSON instance.
 */
const isRawJSON = (val) =>
  val !== null &&
  typeof val === "object" &&
  val.constructor &&
  val.constructor.name === "RawJSON";

/**
 * Iteratively converts a JS value to a JSON string.
 * Used as a fallback when the native JSON.stringify hits the Maximum Call Stack size.
 * Fully compliant with JSON formatting (space), replacers, and toJSON behaviors.
 *
 * @param {any} rootValue The value to stringify.
 * @param {Replacer | Array<string | number> | null} [replacer] User's custom replacer function.
 * @param {string | number} [spaceParam] Indentation for pretty-printing.
 * @returns {string | undefined} The generated JSON string.
 */
const stringifyIteratively = (rootValue, replacer, spaceParam) => {
  let space = "";
  const propertyList = Array.isArray(replacer)
    ? new Set(replacer.map(String))
    : null;

  /**
   * Prepares a value for stringification by resolving toJSON, handling BigInts,
   * applying custom replacers, and unwrapping primitive objects.
   *
   * @param {object|Array} parent The parent object or array holding the value.
   * @param {string} key The key associated with the value.
   * @param {any} val The raw value to process.
   * @returns {any} The processed value ready for stringification.
   */
  const prepareVal = (parent, key, val) => {
    const isObject = val !== null && typeof val === "object";
    const hasToJSON = isObject && typeof val.toJSON === "function";

    if (hasToJSON) {
      val = val.toJSON(key);
    }

    const isNoise = typeof val === "string" && noiseValue.test(val);

    if (isNoise) return val + "n";

    const isBigInt = typeof val === "bigint";

    if (isBigInt) {
      const supportsRawJSON = "rawJSON" in JSON;

      if (supportsRawJSON) return JSON.rawJSON(val.toString());

      return val.toString() + "n";
    }

    const isPostReplacerObject = val !== null && typeof val === "object";

    if (isPostReplacerObject) {
      const isPrimitiveWrapper =
        val instanceof Number ||
        val instanceof String ||
        val instanceof Boolean;

      if (isPrimitiveWrapper) {
        val = val.valueOf();
      }
    }

    return val;
  };

  const rootProcessed = prepareVal({ }, "", rootValue);

  if (isUnstringifiable(rootProcessed)) {
    return undefined;
  }

  const isRootPrimitive =
    rootProcessed === null || typeof rootProcessed !== "object";
  const isRootNativeRawJSON = isRawJSON(rootProcessed);

  if (isRootPrimitive || isRootNativeRawJSON) {
    return originalStringify(rootProcessed);
  }

  const chunks = [];

  const stack = [
    {
      parent: { "": rootProcessed },
      key: "",
      val: rootProcessed,
      isArray: Array.isArray(rootProcessed),
      keys: Array.isArray(rootProcessed) ? null : Object.keys(rootProcessed),
      index: 0,
      first: true,
    },
  ];

  const visited = new WeakSet([rootProcessed]);

  while (stack.length > 0) {
    const node = stack[stack.length - 1];

    if (node.index === 0) {
      chunks.push(node.isArray ? "[" : "{");
    }

    let isDone = false;

    if (node.isArray) {
      if (node.index < node.val.length) {
        if (!node.first) chunks.push(",");

        const childRaw = node.val[node.index];
        const childVal = prepareVal(node.val, String(node.index), childRaw);

        if (isUnstringifiable(childVal)) {
          chunks.push("null");
          node.first = false;
          node.index++;
        } else {
          const isComplexObject =
            childVal !== null && typeof childVal === "object";
          const isNativeRaw = isRawJSON(childVal);

          if (isComplexObject && !isNativeRaw) {
            if (visited.has(childVal)) {
              throw new TypeError("Converting circular structure to JSON");
            }

            visited.add(childVal);

            stack.push({
              parent: node.val,
              key: String(node.index),
              val: childVal,
              isArray: Array.isArray(childVal),
              keys: Array.isArray(childVal) ? null : Object.keys(childVal),
              index: 0,
              first: true,
            });

            node.first = false;
            node.index++;
          } else {
            chunks.push(originalStringify(childVal));
            node.first = false;
            node.index++;
          }
        }
      } else {
        isDone = true;
      }
    } else {
      while (node.index < node.keys.length) {
        const k = node.keys[node.index++];

        const isFilteredOutByArray = propertyList && !propertyList.has(k);

        if (isFilteredOutByArray) continue;

        const childRaw = node.val[k];
        const childVal = prepareVal(node.val, k, childRaw);

        if (isUnstringifiable(childVal)) continue;

        if (!node.first) chunks.push(",");

        {
          chunks.push(originalStringify(k) + ":");
        }

        const isComplexObject =
          childVal !== null && typeof childVal === "object";
        const isNativeRaw = isRawJSON(childVal);

        if (isComplexObject && !isNativeRaw) {
          if (visited.has(childVal)) {
            throw new TypeError("Converting circular structure to JSON");
          }

          visited.add(childVal);

          stack.push({
            parent: node.val,
            key: k,
            val: childVal,
            isArray: Array.isArray(childVal),
            keys: Array.isArray(childVal) ? null : Object.keys(childVal),
            index: 0,
            first: true,
          });

          node.first = false;

          break; // Stop current loop level to process the newly pushed stack node
        } else {
          chunks.push(originalStringify(childVal));
          node.first = false;
        }
      }

      const isNodeFullyProcessed =
        node.index >= node.keys.length && stack[stack.length - 1] === node;

      if (isNodeFullyProcessed) {
        isDone = true;
      }
    }

    if (isDone) {

      if (!node.first && space) ;

      chunks.push(node.isArray ? "]" : "}");
      visited.delete(node.val);
      stack.pop();
    }
  }

  return chunks.join("");
};

/**
 * Converts a JavaScript value to a JSON string.
 *
 * Supports serialization of BigInt values using two strategies:
 * 1. Custom format "123n" → "123" (universal fallback)
 * 2. Native JSON.rawJSON() (Node.js 22+, fastest) when available
 *
 * All other values are serialized exactly like native JSON.stringify().
 *
 * @param {*} value The value to convert to a JSON string.
 * @param {Replacer | Array<string | number> | null} [replacer]
 * A function that alters the behavior of the stringification process,
 * or an array of strings/numbers to indicate properties to exclude.
 * @param {string | number} [space]
 * A string or number to specify indentation or pretty-printing.
 * @returns {string} The JSON string representation.
 */
const JSONStringify = (value, replacer, space) => {
  try {
    const supportsRawJSON = "rawJSON" in JSON;

    if (supportsRawJSON) {
      return originalStringify(
        value,
        (key, val) => {
          if (typeof val === "bigint") return JSON.rawJSON(val.toString());

          const hasFunctionReplacer = typeof replacer === "function";

          if (hasFunctionReplacer) ;

          const isKeyInArrayReplacer =
            Array.isArray(replacer) && replacer.includes(key);

          if (isKeyInArrayReplacer) return val;

          return val;
        },
        space,
      );
    }

    if (!value) return originalStringify(value, replacer, space);

    const convertedToCustomJSON = originalStringify(
      value,
      (key, val) => {
        const isNoise = typeof val === "string" && noiseValue.test(val);

        if (isNoise) return val.toString() + "n"; // Mark noise values with additional "n" to offset the deletion of one "n" during the processing

        if (typeof val === "bigint") return val.toString() + "n";

        const hasFunctionReplacer = typeof replacer === "function";

        if (hasFunctionReplacer) ;

        const isKeyInArrayReplacer =
          Array.isArray(replacer) && replacer.includes(key);

        if (isKeyInArrayReplacer) return val;

        return val;
      },
      space,
    );

    const processedJSON = convertedToCustomJSON.replace(
      bigIntsStringify,
      "$1$2$3",
    ); // Delete one "n" off the end of every BigInt value

    const denoisedJSON = processedJSON.replace(noiseStringify, "$1$2$3"); // Remove one "n" off the end of every noisy string

    return denoisedJSON;
  } catch (error) {
    if (error instanceof RangeError) {
      const convertedJSON = stringifyIteratively(value, replacer);

      if (convertedJSON === undefined) return undefined;

      const supportsRawJSON = "rawJSON" in JSON;

      if (supportsRawJSON) return convertedJSON;

      const processedJSON = convertedJSON.replace(bigIntsStringify, "$1$2$3");

      return processedJSON.replace(noiseStringify, "$1$2$3");
    }

    throw error;
  }
};

const featureCache = new Map();

/**
 * Detects if the current JSON.parse implementation supports the context.source feature.
 *
 * Uses toString() fingerprinting to cache results and automatically detect runtime
 * replacements of JSON.parse (polyfills, mocks, etc.).
 *
 * @returns {boolean} true if context.source is supported, false otherwise.
 */
const isContextSourceSupported = () => {
  const parseFingerprint = JSON.parse.toString();

  if (featureCache.has(parseFingerprint)) {
    return featureCache.get(parseFingerprint);
  }

  try {
    const result = JSON.parse(
      "1",
      (_, __, context) => !!context?.source && context.source === "1",
    );
    featureCache.set(parseFingerprint, result);

    return result;
  } catch {
    featureCache.set(parseFingerprint, false);

    return false;
  }
};

/**
 * Reviver function that converts custom-format BigInt strings back to BigInt values.
 * Also handles "noise" strings that accidentally match the BigInt format.
 *
 * @param {string | number | undefined} key The object key.
 * @param {*} value The value being parsed.
 * @param {object} [context] Parse context (if supported by JSON.parse).
 * @param {Reviver} [userReviver] User's custom reviver function.
 * @returns {any} The transformed value.
 */
const convertMarkedBigIntsReviver = (key, value, context, userReviver) => {
  const isCustomFormatBigInt =
    typeof value === "string" && customFormat.test(value);

  if (isCustomFormatBigInt) return BigInt(value.slice(0, -1));

  const isNoiseValue = typeof value === "string" && noiseValue.test(value);
  if (isNoiseValue) return value.slice(0, -1);

  return value;
};

/**
 * Fast JSON.parse implementation (~2x faster than classic fallback).
 * Uses JSON.parse's context.source feature to detect integers and convert
 * large numbers directly to BigInt without string manipulation.
 *
 * Does not support legacy custom format from v1 of this library.
 *
 * @param {string} text JSON string to parse.
 * @param {Reviver} [reviver] Transform function to apply to each value.
 * @returns {any} Parsed JavaScript value.
 */
const JSONParseV2 = (text, reviver) => {
  return JSON.parse(text, (key, value, context) => {
    const isNumber = typeof value === "number";
    const isOutOfBounds =
      value > Number.MAX_SAFE_INTEGER || value < Number.MIN_SAFE_INTEGER;
    const isBigNumber = isNumber && isOutOfBounds;
    const isInt = context && intRegex.test(context.source);
    const isBigInt = isBigNumber && isInt;

    if (isBigInt) return BigInt(context.source);

    return value;
  });
};

const MAX_INT = Number.MAX_SAFE_INTEGER.toString();
const MAX_DIGITS = MAX_INT.length;
const stringsOrLargeNumbers =
  /"(?:[^"\\]|\\.)*"|-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/g;
const noiseValueWithQuotes = /^"-?\d+n+"$/; // Noise - strings that match the custom format before being converted to it

/**
 * Iteratively traverses the parsed object bottom-up (post-order),
 * emulating the native JSON.parse reviver behavior.
 * This avoids Call Stack overflows (RangeError) on deeply nested structures.
 *
 * @param {any} parsed The natively parsed JSON object.
 * @param {Reviver} [userReviver] User's custom reviver function.
 * @returns {any} The fully processed object.
 */
const applyReviverIteratively = (parsed, userReviver) => {
  const rootHolder = { "": parsed };
  const stack = [{ parent: rootHolder, key: "", visited: false }];

  while (stack.length > 0) {
    const node = stack[stack.length - 1];

    if (!node.visited) {
      node.visited = true;

      const value = node.parent[node.key];
      const isComplexObject = value !== null && typeof value === "object";

      if (isComplexObject) {
        const keys = Object.keys(value);

        for (let i = keys.length - 1; i >= 0; i--) {
          stack.push({ parent: value, key: keys[i], visited: false });
        }
      }
    } else {
      const { parent, key } = node;
      let value = parent[key];

      if (typeof value === "string") {
        const isCustomFormatBigInt = customFormat.test(value);

        if (isCustomFormatBigInt) {
          value = BigInt(value.slice(0, -1));
        } else {
          const isNoise = noiseValue.test(value);

          if (isNoise) value = value.slice(0, -1);
        }
      }

      const isDeleted = value === undefined;

      if (isDeleted) {
        delete parent[key];
      } else {
        parent[key] = value;
      }

      stack.pop();
    }
  }

  return rootHolder[""];
};

/**
 * Pre-processes the JSON string to mark large numbers with an 'n' suffix.
 *
 * @param {string} text The raw JSON string.
 * @returns {string} The serialized string with marked BigInts.
 */
const serializeBigInts = (text) => {
  return text.replace(
    stringsOrLargeNumbers,
    (match, digits, fractional, exponential) => {
      const isString = match[0] === '"';
      const isNoise = isString && noiseValueWithQuotes.test(match);

      if (isNoise) return match.substring(0, match.length - 1) + 'n"'; // Mark noise values with additional "n" to offset the deletion of one "n" during the processing

      const hasFractionalOrExponential = fractional || exponential;

      // With a fixed number of digits, we can correctly use lexicographical comparison to do a numeric comparison
      const isLessThanMaxSafeInt =
        digits &&
        (digits.length < MAX_DIGITS ||
          (digits.length === MAX_DIGITS && digits <= MAX_INT));

      const isStandardValue =
        isString || hasFractionalOrExponential || isLessThanMaxSafeInt;

      if (isStandardValue) return match;

      return '"' + match + 'n"';
    },
  );
};

/**
 * Converts a JSON string into a JavaScript value.
 *
 * Supports parsing of large integers using two strategies:
 * 1. Classic fallback: Marks large numbers with "123n" format, then converts to BigInt
 * 2. Fast path (JSONParseV2): Uses context.source feature (~2x faster) when available
 *
 * All other JSON values are parsed exactly like native JSON.parse().
 *
 * @param {string} text A valid JSON string.
 * @param {Reviver} [reviver]
 * A function that transforms the results. This function is called for each member
 * of the object. If a member contains nested objects, the nested objects are
 * transformed before the parent object is.
 * @returns {any} The parsed JavaScript value.
 * @throws {SyntaxError} If text is not valid JSON.
 */
const JSONParse = (text, reviver) => {
  if (!text) return originalParse(text, reviver);

  try {
    if (isContextSourceSupported()) return JSONParseV2(text, reviver); // Shortcut to a faster (2x) and simpler version

    // Find and mark big numbers with "n"
    const serializedData = serializeBigInts(text);

    return originalParse(serializedData, (key, value, context) =>
      convertMarkedBigIntsReviver(key, value, context, reviver),
    );
  } catch (error) {
    if (error instanceof RangeError) {
      const serializedData = serializeBigInts(text);
      const parsed = originalParse(serializedData);

      return applyReviverIteratively(parsed);
    }

    throw error;
  }
};

class RequestError extends Error {
  name;
  /**
   * http status code
   */
  status;
  /**
   * Request options that lead to the error.
   */
  request;
  /**
   * Response object if a response was received
   */
  response;
  constructor(message, statusCode, options) {
    super(message, { cause: options.cause });
    this.name = "HttpError";
    this.status = Number.parseInt(statusCode);
    if (Number.isNaN(this.status)) {
      this.status = 0;
    }
    /* v8 ignore else -- @preserve -- Bug with vitest coverage where it sees an else branch that doesn't exist */
    if ("response" in options) {
      this.response = options.response;
    }
    const requestCopy = Object.assign({}, options.request);
    if (options.request.headers.authorization) {
      requestCopy.headers = Object.assign({}, options.request.headers, {
        authorization: options.request.headers.authorization.replace(
          /(?<! ) .*$/,
          " [REDACTED]"
        )
      });
    }
    requestCopy.url = requestCopy.url.replace(/\bclient_secret=\w+/g, "client_secret=[REDACTED]").replace(/\baccess_token=\w+/g, "access_token=[REDACTED]");
    this.request = requestCopy;
  }
}

// pkg/dist-src/index.js

// pkg/dist-src/version.js
var VERSION$6 = "10.0.16";

// pkg/dist-src/defaults.js
var defaults_default = {
  headers: {
    "user-agent": `octokit-request.js/${VERSION$6} ${getUserAgent()}`
  }
};

// pkg/dist-src/is-plain-object.js
function isPlainObject(value) {
  if (typeof value !== "object" || value === null) return false;
  if (Object.prototype.toString.call(value) !== "[object Object]") return false;
  const proto = Object.getPrototypeOf(value);
  if (proto === null) return true;
  const Ctor = Object.prototype.hasOwnProperty.call(proto, "constructor") && proto.constructor;
  return typeof Ctor === "function" && Ctor instanceof Ctor && Function.prototype.call(Ctor) === Function.prototype.call(value);
}
var noop$1 = () => "";
async function fetchWrapper(requestOptions) {
  const fetch = requestOptions.request?.fetch || globalThis.fetch;
  if (!fetch) {
    throw new Error(
      "fetch is not set. Please pass a fetch implementation as new Octokit({ request: { fetch }}). Learn more at https://github.com/octokit/octokit.js/#fetch-missing"
    );
  }
  const log = requestOptions.request?.log || console;
  const parseSuccessResponseBody = requestOptions.request?.parseSuccessResponseBody !== false;
  const body = isPlainObject(requestOptions.body) || Array.isArray(requestOptions.body) ? JSONStringify(requestOptions.body) : requestOptions.body;
  const requestHeaders = Object.fromEntries(
    Object.entries(requestOptions.headers).map(([name, value]) => [
      name,
      String(value)
    ])
  );
  let fetchResponse;
  try {
    fetchResponse = await fetch(requestOptions.url, {
      method: requestOptions.method,
      body,
      redirect: requestOptions.request?.redirect,
      headers: requestHeaders,
      signal: requestOptions.request?.signal,
      // duplex must be set if request.body is ReadableStream or Async Iterables.
      // See https://fetch.spec.whatwg.org/#dom-requestinit-duplex.
      ...requestOptions.body && { duplex: "half" }
    });
  } catch (error) {
    let message = "Unknown Error";
    if (error instanceof Error) {
      if (error.name === "AbortError") {
        error.status = 500;
        throw error;
      }
      message = error.message;
      if (error.name === "TypeError" && "cause" in error) {
        if (error.cause instanceof Error) {
          message = error.cause.message;
        } else if (typeof error.cause === "string") {
          message = error.cause;
        }
      }
    }
    const requestError = new RequestError(message, 500, {
      request: requestOptions
    });
    requestError.cause = error;
    throw requestError;
  }
  const status = fetchResponse.status;
  const url = fetchResponse.url;
  const responseHeaders = {};
  for (const [key, value] of fetchResponse.headers) {
    responseHeaders[key] = value;
  }
  const octokitResponse = {
    url,
    status,
    headers: responseHeaders,
    data: ""
  };
  if ("deprecation" in responseHeaders) {
    const matches = responseHeaders.link && responseHeaders.link.match(/<([^<>]+)>; rel="deprecation"/);
    const deprecationLink = matches && matches.pop();
    log.warn(
      `[@octokit/request] "${requestOptions.method} ${requestOptions.url}" is deprecated. It is scheduled to be removed on ${responseHeaders.sunset}${deprecationLink ? `. See ${deprecationLink}` : ""}`
    );
  }
  if (status === 204 || status === 205) {
    return octokitResponse;
  }
  if (requestOptions.method === "HEAD") {
    if (status < 400) {
      return octokitResponse;
    }
    throw new RequestError(fetchResponse.statusText, status, {
      response: octokitResponse,
      request: requestOptions
    });
  }
  if (status === 304) {
    octokitResponse.data = await getResponseData(fetchResponse);
    throw new RequestError("Not modified", status, {
      response: octokitResponse,
      request: requestOptions
    });
  }
  if (status >= 400) {
    octokitResponse.data = await getResponseData(fetchResponse);
    throw new RequestError(toErrorMessage(octokitResponse.data), status, {
      response: octokitResponse,
      request: requestOptions
    });
  }
  octokitResponse.data = parseSuccessResponseBody ? await getResponseData(fetchResponse) : fetchResponse.body;
  return octokitResponse;
}
async function getResponseData(response) {
  const contentType = response.headers.get("content-type");
  if (!contentType) {
    return response.text().catch(noop$1);
  }
  const mimetype = parse(contentType);
  if (isJSONResponse(mimetype)) {
    let text = "";
    try {
      text = await response.text();
      return JSONParse(text);
    } catch (err) {
      return text;
    }
  } else if (mimetype.type.startsWith("text/") || // `application/octet-stream` is the canonical "arbitrary binary" type
  // (RFC 2046) and must never be decoded as text, even when the response
  // carries a (misleading) `charset=utf-8` parameter — see #751.
  mimetype.parameters.charset?.toLowerCase() === "utf-8" && mimetype.type !== "application/octet-stream") {
    return response.text().catch(noop$1);
  } else {
    return response.arrayBuffer().catch(
      /* v8 ignore next -- @preserve */
      () => new ArrayBuffer(0)
    );
  }
}
function isJSONResponse(mimetype) {
  return mimetype.type === "application/json" || mimetype.type === "application/scim+json";
}
function toErrorMessage(data) {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return "Unknown error";
  }
  if (typeof data === "object" && data !== null && "message" in data) {
    const objectData = data;
    const suffix = "documentation_url" in objectData ? ` - ${objectData.documentation_url}` : "";
    return Array.isArray(objectData.errors) ? `${objectData.message}: ${objectData.errors.map((v) => JSON.stringify(v)).join(", ")}${suffix}` : `${objectData.message}${suffix}`;
  }
  return `Unknown error: ${JSON.stringify(data)}`;
}

// pkg/dist-src/with-defaults.js
function withDefaults$1(oldEndpoint, newDefaults) {
  const endpoint2 = oldEndpoint.defaults(newDefaults);
  const newApi = function(route, parameters) {
    const endpointOptions = endpoint2.merge(route, parameters);
    if (!endpointOptions.request || !endpointOptions.request.hook) {
      return fetchWrapper(endpoint2.parse(endpointOptions));
    }
    const request2 = (route2, parameters2) => {
      return fetchWrapper(
        endpoint2.parse(endpoint2.merge(route2, parameters2))
      );
    };
    Object.assign(request2, {
      endpoint: endpoint2,
      defaults: withDefaults$1.bind(null, endpoint2)
    });
    return endpointOptions.request.hook(request2, endpointOptions);
  };
  return Object.assign(newApi, {
    endpoint: endpoint2,
    defaults: withDefaults$1.bind(null, endpoint2)
  });
}

// pkg/dist-src/index.js
var request = withDefaults$1(endpoint, defaults_default);
/* v8 ignore next -- @preserve */
/* v8 ignore else -- @preserve */

// pkg/dist-src/index.js

// pkg/dist-src/version.js
var VERSION$5 = "0.0.0-development";

// pkg/dist-src/error.js
function _buildMessageForResponseErrors(data) {
  return `Request failed due to following response errors:
` + data.errors.map((e) => ` - ${e.message}`).join("\n");
}
var GraphqlResponseError = class extends Error {
  constructor(request2, headers, response) {
    super(_buildMessageForResponseErrors(response));
    this.request = request2;
    this.headers = headers;
    this.response = response;
    this.errors = response.errors;
    this.data = response.data;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
  request;
  headers;
  response;
  name = "GraphqlResponseError";
  errors;
  data;
};

// pkg/dist-src/graphql.js
var NON_VARIABLE_OPTIONS = [
  "method",
  "baseUrl",
  "url",
  "headers",
  "request",
  "query",
  "mediaType",
  "operationName"
];
var FORBIDDEN_VARIABLE_OPTIONS = ["query", "method", "url"];
var GHES_V3_SUFFIX_REGEX = /\/api\/v3\/?$/;
function graphql(request2, query, options) {
  if (options) {
    if (typeof query === "string" && "query" in options) {
      return Promise.reject(
        new Error(`[@octokit/graphql] "query" cannot be used as variable name`)
      );
    }
    for (const key in options) {
      if (!FORBIDDEN_VARIABLE_OPTIONS.includes(key)) continue;
      return Promise.reject(
        new Error(
          `[@octokit/graphql] "${key}" cannot be used as variable name`
        )
      );
    }
  }
  const parsedOptions = typeof query === "string" ? Object.assign({ query }, options) : query;
  const requestOptions = Object.keys(
    parsedOptions
  ).reduce((result, key) => {
    if (NON_VARIABLE_OPTIONS.includes(key)) {
      result[key] = parsedOptions[key];
      return result;
    }
    if (!result.variables) {
      result.variables = {};
    }
    result.variables[key] = parsedOptions[key];
    return result;
  }, {});
  const baseUrl = parsedOptions.baseUrl || request2.endpoint.DEFAULTS.baseUrl;
  if (GHES_V3_SUFFIX_REGEX.test(baseUrl)) {
    requestOptions.url = baseUrl.replace(GHES_V3_SUFFIX_REGEX, "/api/graphql");
  }
  return request2(requestOptions).then((response) => {
    if (response.data.errors) {
      const headers = {};
      for (const key of Object.keys(response.headers)) {
        headers[key] = response.headers[key];
      }
      throw new GraphqlResponseError(
        requestOptions,
        headers,
        response.data
      );
    }
    return response.data.data;
  });
}

// pkg/dist-src/with-defaults.js
function withDefaults(request2, newDefaults) {
  const newRequest = request2.defaults(newDefaults);
  const newApi = (query, options) => {
    return graphql(newRequest, query, options);
  };
  return Object.assign(newApi, {
    defaults: withDefaults.bind(null, newRequest),
    endpoint: newRequest.endpoint
  });
}

// pkg/dist-src/index.js
withDefaults(request, {
  headers: {
    "user-agent": `octokit-graphql.js/${VERSION$5} ${getUserAgent()}`
  },
  method: "POST",
  url: "/graphql"
});
function withCustomRequest(customRequest) {
  return withDefaults(customRequest, {
    method: "POST",
    url: "/graphql"
  });
}
/* v8 ignore if -- @preserve */

// pkg/dist-src/is-jwt.js
var b64url = "(?:[a-zA-Z0-9_-]+)";
var sep = "\\.";
var jwtRE = new RegExp(`^${b64url}${sep}${b64url}${sep}${b64url}$`);
var isJWT = jwtRE.test.bind(jwtRE);

// pkg/dist-src/auth.js
async function auth(token) {
  const isApp = isJWT(token);
  const isInstallation = token.startsWith("v1.") || token.startsWith("ghs_");
  const isUserToServer = token.startsWith("ghu_");
  const tokenType = isApp ? "app" : isInstallation ? "installation" : isUserToServer ? "user-to-server" : "oauth";
  return {
    type: "token",
    token,
    tokenType
  };
}

// pkg/dist-src/with-authorization-prefix.js
function withAuthorizationPrefix(token) {
  if (token.split(/\./).length === 3) {
    return `bearer ${token}`;
  }
  return `token ${token}`;
}

// pkg/dist-src/hook.js
async function hook(token, request, route, parameters) {
  const endpoint = request.endpoint.merge(
    route,
    parameters
  );
  endpoint.headers.authorization = withAuthorizationPrefix(token);
  return request(endpoint);
}

// pkg/dist-src/index.js
var createTokenAuth = function createTokenAuth2(token) {
  if (!token) {
    throw new Error("[@octokit/auth-token] No token passed to createTokenAuth");
  }
  if (typeof token !== "string") {
    throw new Error(
      "[@octokit/auth-token] Token passed to createTokenAuth is not a string"
    );
  }
  token = token.replace(/^(token|bearer) +/i, "");
  return Object.assign(auth.bind(null, token), {
    hook: hook.bind(null, token)
  });
};

const VERSION$4 = "7.0.8";

const noop = () => {
};
const consoleWarn = console.warn.bind(console);
const consoleError = console.error.bind(console);
function createLogger(logger = {}) {
  if (typeof logger.debug !== "function") {
    logger.debug = noop;
  }
  if (typeof logger.info !== "function") {
    logger.info = noop;
  }
  if (typeof logger.warn !== "function") {
    logger.warn = consoleWarn;
  }
  if (typeof logger.error !== "function") {
    logger.error = consoleError;
  }
  return logger;
}
const userAgentTrail = `octokit-core.js/${VERSION$4} ${getUserAgent()}`;
let Octokit$1 = class Octokit {
  static VERSION = VERSION$4;
  static defaults(defaults) {
    const OctokitWithDefaults = class extends this {
      constructor(...args) {
        const options = args[0] || {};
        if (typeof defaults === "function") {
          super(defaults(options));
          return;
        }
        super(
          Object.assign(
            {},
            defaults,
            options,
            options.userAgent && defaults.userAgent ? {
              userAgent: `${options.userAgent} ${defaults.userAgent}`
            } : null
          )
        );
      }
    };
    return OctokitWithDefaults;
  }
  static plugins = [];
  /**
   * Attach a plugin (or many) to your Octokit instance.
   *
   * @example
   * const API = Octokit.plugin(plugin1, plugin2, plugin3, ...)
   */
  static plugin(...newPlugins) {
    const currentPlugins = this.plugins;
    const NewOctokit = class extends this {
      static plugins = currentPlugins.concat(
        newPlugins.filter((plugin) => !currentPlugins.includes(plugin))
      );
    };
    return NewOctokit;
  }
  constructor(options = {}) {
    const hook = new Hook.Collection();
    const requestDefaults = {
      baseUrl: request.endpoint.DEFAULTS.baseUrl,
      headers: {},
      request: Object.assign({}, options.request, {
        // @ts-ignore internal usage only, no need to type
        hook: hook.bind(null, "request")
      }),
      mediaType: {
        previews: [],
        format: ""
      }
    };
    requestDefaults.headers["user-agent"] = options.userAgent ? `${options.userAgent} ${userAgentTrail}` : userAgentTrail;
    if (options.baseUrl) {
      requestDefaults.baseUrl = options.baseUrl;
    }
    if (options.previews) {
      requestDefaults.mediaType.previews = options.previews;
    }
    if (options.timeZone) {
      requestDefaults.headers["time-zone"] = options.timeZone;
    }
    this.request = request.defaults(requestDefaults);
    this.graphql = withCustomRequest(this.request).defaults(requestDefaults);
    this.log = createLogger(options.log);
    this.hook = hook;
    if (!options.authStrategy) {
      if (!options.auth) {
        this.auth = async () => ({
          type: "unauthenticated"
        });
      } else {
        const auth = createTokenAuth(options.auth);
        hook.wrap("request", auth.hook);
        this.auth = auth;
      }
    } else {
      const { authStrategy, ...otherOptions } = options;
      const auth = authStrategy(
        Object.assign(
          {
            request: this.request,
            log: this.log,
            // we pass the current octokit instance as well as its constructor options
            // to allow for authentication strategies that return a new octokit instance
            // that shares the same internal state as the current one. The original
            // requirement for this was the "event-octokit" authentication strategy
            // of https://github.com/probot/octokit-auth-probot.
            octokit: this,
            octokitOptions: otherOptions
          },
          options.auth
        )
      );
      hook.wrap("request", auth.hook);
      this.auth = auth;
    }
    const classConstructor = this.constructor;
    for (let i = 0; i < classConstructor.plugins.length; ++i) {
      Object.assign(this, classConstructor.plugins[i](this, options));
    }
  }
  // assigned during constructor
  request;
  graphql;
  log;
  hook;
  // TODO: type `octokit.auth` based on passed options.authStrategy
  auth;
};

const VERSION$3 = "6.0.0";

function requestLog(octokit) {
  octokit.hook.wrap("request", (request, options) => {
    octokit.log.debug("request", options);
    const start = Date.now();
    const requestOptions = octokit.request.endpoint.parse(options);
    const path = requestOptions.url.replace(options.baseUrl, "");
    return request(options).then((response) => {
      const requestId = response.headers["x-github-request-id"];
      octokit.log.info(
        `${requestOptions.method} ${path} - ${response.status} with id ${requestId} in ${Date.now() - start}ms`
      );
      return response;
    }).catch((error) => {
      const requestId = error.response?.headers["x-github-request-id"] || "UNKNOWN";
      octokit.log.error(
        `${requestOptions.method} ${path} - ${error.status} with id ${requestId} in ${Date.now() - start}ms`
      );
      throw error;
    });
  });
}
requestLog.VERSION = VERSION$3;

// pkg/dist-src/version.js
var VERSION$2 = "0.0.0-development";

// pkg/dist-src/normalize-paginated-list-response.js
function normalizePaginatedListResponse(response) {
  if (!response.data) {
    return {
      ...response,
      data: []
    };
  }
  const responseNeedsNormalization = ("total_count" in response.data || "total_commits" in response.data) && !("url" in response.data);
  if (!responseNeedsNormalization) return response;
  const incompleteResults = response.data.incomplete_results;
  const repositorySelection = response.data.repository_selection;
  const totalCount = response.data.total_count;
  const totalCommits = response.data.total_commits;
  delete response.data.incomplete_results;
  delete response.data.repository_selection;
  delete response.data.total_count;
  delete response.data.total_commits;
  const namespaceKey = Object.keys(response.data)[0];
  const data = response.data[namespaceKey];
  response.data = data;
  if (typeof incompleteResults !== "undefined") {
    response.data.incomplete_results = incompleteResults;
  }
  if (typeof repositorySelection !== "undefined") {
    response.data.repository_selection = repositorySelection;
  }
  response.data.total_count = totalCount;
  response.data.total_commits = totalCommits;
  return response;
}

// pkg/dist-src/iterator.js
function iterator(octokit, route, parameters) {
  const options = typeof route === "function" ? route.endpoint(parameters) : octokit.request.endpoint(route, parameters);
  const requestMethod = typeof route === "function" ? route : octokit.request;
  const method = options.method;
  const headers = options.headers;
  let url = options.url;
  return {
    [Symbol.asyncIterator]: () => ({
      async next() {
        if (!url) return { done: true };
        try {
          const response = await requestMethod({ method, url, headers });
          const normalizedResponse = normalizePaginatedListResponse(response);
          url = ((normalizedResponse.headers.link || "").match(
            /<([^<>]+)>;\s*rel="next"/
          ) || [])[1];
          if (!url && "total_commits" in normalizedResponse.data) {
            const parsedUrl = new URL(normalizedResponse.url);
            const params = parsedUrl.searchParams;
            const page = parseInt(params.get("page") || "1", 10);
            const per_page = parseInt(params.get("per_page") || "250", 10);
            if (page * per_page < normalizedResponse.data.total_commits) {
              params.set("page", String(page + 1));
              url = parsedUrl.toString();
            }
          }
          return { value: normalizedResponse };
        } catch (error) {
          if (error.status !== 409) throw error;
          url = "";
          return {
            value: {
              status: 200,
              headers: {},
              data: []
            }
          };
        }
      }
    })
  };
}

// pkg/dist-src/paginate.js
function paginate(octokit, route, parameters, mapFn) {
  if (typeof parameters === "function") {
    mapFn = parameters;
    parameters = void 0;
  }
  return gather(
    octokit,
    [],
    iterator(octokit, route, parameters)[Symbol.asyncIterator](),
    mapFn
  );
}
function gather(octokit, results, iterator2, mapFn) {
  return iterator2.next().then((result) => {
    if (result.done) {
      return results;
    }
    let earlyExit = false;
    function done() {
      earlyExit = true;
    }
    results = results.concat(
      mapFn ? mapFn(result.value, done) : result.value.data
    );
    if (earlyExit) {
      return results;
    }
    return gather(octokit, results, iterator2, mapFn);
  });
}

// pkg/dist-src/compose-paginate.js
Object.assign(paginate, {
  iterator
});

// pkg/dist-src/index.js
function paginateRest(octokit) {
  return {
    paginate: Object.assign(paginate.bind(null, octokit), {
      iterator: iterator.bind(null, octokit)
    })
  };
}
paginateRest.VERSION = VERSION$2;

const VERSION$1 = "17.0.0";

const Endpoints = {
  actions: {
    addCustomLabelsToSelfHostedRunnerForOrg: [
      "POST /orgs/{org}/actions/runners/{runner_id}/labels"
    ],
    addCustomLabelsToSelfHostedRunnerForRepo: [
      "POST /repos/{owner}/{repo}/actions/runners/{runner_id}/labels"
    ],
    addRepoAccessToSelfHostedRunnerGroupInOrg: [
      "PUT /orgs/{org}/actions/runner-groups/{runner_group_id}/repositories/{repository_id}"
    ],
    addSelectedRepoToOrgSecret: [
      "PUT /orgs/{org}/actions/secrets/{secret_name}/repositories/{repository_id}"
    ],
    addSelectedRepoToOrgVariable: [
      "PUT /orgs/{org}/actions/variables/{name}/repositories/{repository_id}"
    ],
    approveWorkflowRun: [
      "POST /repos/{owner}/{repo}/actions/runs/{run_id}/approve"
    ],
    cancelWorkflowRun: [
      "POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel"
    ],
    createEnvironmentVariable: [
      "POST /repos/{owner}/{repo}/environments/{environment_name}/variables"
    ],
    createHostedRunnerForOrg: ["POST /orgs/{org}/actions/hosted-runners"],
    createOrUpdateEnvironmentSecret: [
      "PUT /repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}"
    ],
    createOrUpdateOrgSecret: ["PUT /orgs/{org}/actions/secrets/{secret_name}"],
    createOrUpdateRepoSecret: [
      "PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}"
    ],
    createOrgVariable: ["POST /orgs/{org}/actions/variables"],
    createRegistrationTokenForOrg: [
      "POST /orgs/{org}/actions/runners/registration-token"
    ],
    createRegistrationTokenForRepo: [
      "POST /repos/{owner}/{repo}/actions/runners/registration-token"
    ],
    createRemoveTokenForOrg: ["POST /orgs/{org}/actions/runners/remove-token"],
    createRemoveTokenForRepo: [
      "POST /repos/{owner}/{repo}/actions/runners/remove-token"
    ],
    createRepoVariable: ["POST /repos/{owner}/{repo}/actions/variables"],
    createWorkflowDispatch: [
      "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches"
    ],
    deleteActionsCacheById: [
      "DELETE /repos/{owner}/{repo}/actions/caches/{cache_id}"
    ],
    deleteActionsCacheByKey: [
      "DELETE /repos/{owner}/{repo}/actions/caches{?key,ref}"
    ],
    deleteArtifact: [
      "DELETE /repos/{owner}/{repo}/actions/artifacts/{artifact_id}"
    ],
    deleteCustomImageFromOrg: [
      "DELETE /orgs/{org}/actions/hosted-runners/images/custom/{image_definition_id}"
    ],
    deleteCustomImageVersionFromOrg: [
      "DELETE /orgs/{org}/actions/hosted-runners/images/custom/{image_definition_id}/versions/{version}"
    ],
    deleteEnvironmentSecret: [
      "DELETE /repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}"
    ],
    deleteEnvironmentVariable: [
      "DELETE /repos/{owner}/{repo}/environments/{environment_name}/variables/{name}"
    ],
    deleteHostedRunnerForOrg: [
      "DELETE /orgs/{org}/actions/hosted-runners/{hosted_runner_id}"
    ],
    deleteOrgSecret: ["DELETE /orgs/{org}/actions/secrets/{secret_name}"],
    deleteOrgVariable: ["DELETE /orgs/{org}/actions/variables/{name}"],
    deleteRepoSecret: [
      "DELETE /repos/{owner}/{repo}/actions/secrets/{secret_name}"
    ],
    deleteRepoVariable: [
      "DELETE /repos/{owner}/{repo}/actions/variables/{name}"
    ],
    deleteSelfHostedRunnerFromOrg: [
      "DELETE /orgs/{org}/actions/runners/{runner_id}"
    ],
    deleteSelfHostedRunnerFromRepo: [
      "DELETE /repos/{owner}/{repo}/actions/runners/{runner_id}"
    ],
    deleteWorkflowRun: ["DELETE /repos/{owner}/{repo}/actions/runs/{run_id}"],
    deleteWorkflowRunLogs: [
      "DELETE /repos/{owner}/{repo}/actions/runs/{run_id}/logs"
    ],
    disableSelectedRepositoryGithubActionsOrganization: [
      "DELETE /orgs/{org}/actions/permissions/repositories/{repository_id}"
    ],
    disableWorkflow: [
      "PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/disable"
    ],
    downloadArtifact: [
      "GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}"
    ],
    downloadJobLogsForWorkflowRun: [
      "GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs"
    ],
    downloadWorkflowRunAttemptLogs: [
      "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/logs"
    ],
    downloadWorkflowRunLogs: [
      "GET /repos/{owner}/{repo}/actions/runs/{run_id}/logs"
    ],
    enableSelectedRepositoryGithubActionsOrganization: [
      "PUT /orgs/{org}/actions/permissions/repositories/{repository_id}"
    ],
    enableWorkflow: [
      "PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/enable"
    ],
    forceCancelWorkflowRun: [
      "POST /repos/{owner}/{repo}/actions/runs/{run_id}/force-cancel"
    ],
    generateRunnerJitconfigForOrg: [
      "POST /orgs/{org}/actions/runners/generate-jitconfig"
    ],
    generateRunnerJitconfigForRepo: [
      "POST /repos/{owner}/{repo}/actions/runners/generate-jitconfig"
    ],
    getActionsCacheList: ["GET /repos/{owner}/{repo}/actions/caches"],
    getActionsCacheUsage: ["GET /repos/{owner}/{repo}/actions/cache/usage"],
    getActionsCacheUsageByRepoForOrg: [
      "GET /orgs/{org}/actions/cache/usage-by-repository"
    ],
    getActionsCacheUsageForOrg: ["GET /orgs/{org}/actions/cache/usage"],
    getAllowedActionsOrganization: [
      "GET /orgs/{org}/actions/permissions/selected-actions"
    ],
    getAllowedActionsRepository: [
      "GET /repos/{owner}/{repo}/actions/permissions/selected-actions"
    ],
    getArtifact: ["GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}"],
    getCustomImageForOrg: [
      "GET /orgs/{org}/actions/hosted-runners/images/custom/{image_definition_id}"
    ],
    getCustomImageVersionForOrg: [
      "GET /orgs/{org}/actions/hosted-runners/images/custom/{image_definition_id}/versions/{version}"
    ],
    getCustomOidcSubClaimForRepo: [
      "GET /repos/{owner}/{repo}/actions/oidc/customization/sub"
    ],
    getEnvironmentPublicKey: [
      "GET /repos/{owner}/{repo}/environments/{environment_name}/secrets/public-key"
    ],
    getEnvironmentSecret: [
      "GET /repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}"
    ],
    getEnvironmentVariable: [
      "GET /repos/{owner}/{repo}/environments/{environment_name}/variables/{name}"
    ],
    getGithubActionsDefaultWorkflowPermissionsOrganization: [
      "GET /orgs/{org}/actions/permissions/workflow"
    ],
    getGithubActionsDefaultWorkflowPermissionsRepository: [
      "GET /repos/{owner}/{repo}/actions/permissions/workflow"
    ],
    getGithubActionsPermissionsOrganization: [
      "GET /orgs/{org}/actions/permissions"
    ],
    getGithubActionsPermissionsRepository: [
      "GET /repos/{owner}/{repo}/actions/permissions"
    ],
    getHostedRunnerForOrg: [
      "GET /orgs/{org}/actions/hosted-runners/{hosted_runner_id}"
    ],
    getHostedRunnersGithubOwnedImagesForOrg: [
      "GET /orgs/{org}/actions/hosted-runners/images/github-owned"
    ],
    getHostedRunnersLimitsForOrg: [
      "GET /orgs/{org}/actions/hosted-runners/limits"
    ],
    getHostedRunnersMachineSpecsForOrg: [
      "GET /orgs/{org}/actions/hosted-runners/machine-sizes"
    ],
    getHostedRunnersPartnerImagesForOrg: [
      "GET /orgs/{org}/actions/hosted-runners/images/partner"
    ],
    getHostedRunnersPlatformsForOrg: [
      "GET /orgs/{org}/actions/hosted-runners/platforms"
    ],
    getJobForWorkflowRun: ["GET /repos/{owner}/{repo}/actions/jobs/{job_id}"],
    getOrgPublicKey: ["GET /orgs/{org}/actions/secrets/public-key"],
    getOrgSecret: ["GET /orgs/{org}/actions/secrets/{secret_name}"],
    getOrgVariable: ["GET /orgs/{org}/actions/variables/{name}"],
    getPendingDeploymentsForRun: [
      "GET /repos/{owner}/{repo}/actions/runs/{run_id}/pending_deployments"
    ],
    getRepoPermissions: [
      "GET /repos/{owner}/{repo}/actions/permissions",
      {},
      { renamed: ["actions", "getGithubActionsPermissionsRepository"] }
    ],
    getRepoPublicKey: ["GET /repos/{owner}/{repo}/actions/secrets/public-key"],
    getRepoSecret: ["GET /repos/{owner}/{repo}/actions/secrets/{secret_name}"],
    getRepoVariable: ["GET /repos/{owner}/{repo}/actions/variables/{name}"],
    getReviewsForRun: [
      "GET /repos/{owner}/{repo}/actions/runs/{run_id}/approvals"
    ],
    getSelfHostedRunnerForOrg: ["GET /orgs/{org}/actions/runners/{runner_id}"],
    getSelfHostedRunnerForRepo: [
      "GET /repos/{owner}/{repo}/actions/runners/{runner_id}"
    ],
    getWorkflow: ["GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}"],
    getWorkflowAccessToRepository: [
      "GET /repos/{owner}/{repo}/actions/permissions/access"
    ],
    getWorkflowRun: ["GET /repos/{owner}/{repo}/actions/runs/{run_id}"],
    getWorkflowRunAttempt: [
      "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}"
    ],
    getWorkflowRunUsage: [
      "GET /repos/{owner}/{repo}/actions/runs/{run_id}/timing"
    ],
    getWorkflowUsage: [
      "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/timing"
    ],
    listArtifactsForRepo: ["GET /repos/{owner}/{repo}/actions/artifacts"],
    listCustomImageVersionsForOrg: [
      "GET /orgs/{org}/actions/hosted-runners/images/custom/{image_definition_id}/versions"
    ],
    listCustomImagesForOrg: [
      "GET /orgs/{org}/actions/hosted-runners/images/custom"
    ],
    listEnvironmentSecrets: [
      "GET /repos/{owner}/{repo}/environments/{environment_name}/secrets"
    ],
    listEnvironmentVariables: [
      "GET /repos/{owner}/{repo}/environments/{environment_name}/variables"
    ],
    listGithubHostedRunnersInGroupForOrg: [
      "GET /orgs/{org}/actions/runner-groups/{runner_group_id}/hosted-runners"
    ],
    listHostedRunnersForOrg: ["GET /orgs/{org}/actions/hosted-runners"],
    listJobsForWorkflowRun: [
      "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs"
    ],
    listJobsForWorkflowRunAttempt: [
      "GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs"
    ],
    listLabelsForSelfHostedRunnerForOrg: [
      "GET /orgs/{org}/actions/runners/{runner_id}/labels"
    ],
    listLabelsForSelfHostedRunnerForRepo: [
      "GET /repos/{owner}/{repo}/actions/runners/{runner_id}/labels"
    ],
    listOrgSecrets: ["GET /orgs/{org}/actions/secrets"],
    listOrgVariables: ["GET /orgs/{org}/actions/variables"],
    listRepoOrganizationSecrets: [
      "GET /repos/{owner}/{repo}/actions/organization-secrets"
    ],
    listRepoOrganizationVariables: [
      "GET /repos/{owner}/{repo}/actions/organization-variables"
    ],
    listRepoSecrets: ["GET /repos/{owner}/{repo}/actions/secrets"],
    listRepoVariables: ["GET /repos/{owner}/{repo}/actions/variables"],
    listRepoWorkflows: ["GET /repos/{owner}/{repo}/actions/workflows"],
    listRunnerApplicationsForOrg: ["GET /orgs/{org}/actions/runners/downloads"],
    listRunnerApplicationsForRepo: [
      "GET /repos/{owner}/{repo}/actions/runners/downloads"
    ],
    listSelectedReposForOrgSecret: [
      "GET /orgs/{org}/actions/secrets/{secret_name}/repositories"
    ],
    listSelectedReposForOrgVariable: [
      "GET /orgs/{org}/actions/variables/{name}/repositories"
    ],
    listSelectedRepositoriesEnabledGithubActionsOrganization: [
      "GET /orgs/{org}/actions/permissions/repositories"
    ],
    listSelfHostedRunnersForOrg: ["GET /orgs/{org}/actions/runners"],
    listSelfHostedRunnersForRepo: ["GET /repos/{owner}/{repo}/actions/runners"],
    listWorkflowRunArtifacts: [
      "GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts"
    ],
    listWorkflowRuns: [
      "GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs"
    ],
    listWorkflowRunsForRepo: ["GET /repos/{owner}/{repo}/actions/runs"],
    reRunJobForWorkflowRun: [
      "POST /repos/{owner}/{repo}/actions/jobs/{job_id}/rerun"
    ],
    reRunWorkflow: ["POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun"],
    reRunWorkflowFailedJobs: [
      "POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs"
    ],
    removeAllCustomLabelsFromSelfHostedRunnerForOrg: [
      "DELETE /orgs/{org}/actions/runners/{runner_id}/labels"
    ],
    removeAllCustomLabelsFromSelfHostedRunnerForRepo: [
      "DELETE /repos/{owner}/{repo}/actions/runners/{runner_id}/labels"
    ],
    removeCustomLabelFromSelfHostedRunnerForOrg: [
      "DELETE /orgs/{org}/actions/runners/{runner_id}/labels/{name}"
    ],
    removeCustomLabelFromSelfHostedRunnerForRepo: [
      "DELETE /repos/{owner}/{repo}/actions/runners/{runner_id}/labels/{name}"
    ],
    removeSelectedRepoFromOrgSecret: [
      "DELETE /orgs/{org}/actions/secrets/{secret_name}/repositories/{repository_id}"
    ],
    removeSelectedRepoFromOrgVariable: [
      "DELETE /orgs/{org}/actions/variables/{name}/repositories/{repository_id}"
    ],
    reviewCustomGatesForRun: [
      "POST /repos/{owner}/{repo}/actions/runs/{run_id}/deployment_protection_rule"
    ],
    reviewPendingDeploymentsForRun: [
      "POST /repos/{owner}/{repo}/actions/runs/{run_id}/pending_deployments"
    ],
    setAllowedActionsOrganization: [
      "PUT /orgs/{org}/actions/permissions/selected-actions"
    ],
    setAllowedActionsRepository: [
      "PUT /repos/{owner}/{repo}/actions/permissions/selected-actions"
    ],
    setCustomLabelsForSelfHostedRunnerForOrg: [
      "PUT /orgs/{org}/actions/runners/{runner_id}/labels"
    ],
    setCustomLabelsForSelfHostedRunnerForRepo: [
      "PUT /repos/{owner}/{repo}/actions/runners/{runner_id}/labels"
    ],
    setCustomOidcSubClaimForRepo: [
      "PUT /repos/{owner}/{repo}/actions/oidc/customization/sub"
    ],
    setGithubActionsDefaultWorkflowPermissionsOrganization: [
      "PUT /orgs/{org}/actions/permissions/workflow"
    ],
    setGithubActionsDefaultWorkflowPermissionsRepository: [
      "PUT /repos/{owner}/{repo}/actions/permissions/workflow"
    ],
    setGithubActionsPermissionsOrganization: [
      "PUT /orgs/{org}/actions/permissions"
    ],
    setGithubActionsPermissionsRepository: [
      "PUT /repos/{owner}/{repo}/actions/permissions"
    ],
    setSelectedReposForOrgSecret: [
      "PUT /orgs/{org}/actions/secrets/{secret_name}/repositories"
    ],
    setSelectedReposForOrgVariable: [
      "PUT /orgs/{org}/actions/variables/{name}/repositories"
    ],
    setSelectedRepositoriesEnabledGithubActionsOrganization: [
      "PUT /orgs/{org}/actions/permissions/repositories"
    ],
    setWorkflowAccessToRepository: [
      "PUT /repos/{owner}/{repo}/actions/permissions/access"
    ],
    updateEnvironmentVariable: [
      "PATCH /repos/{owner}/{repo}/environments/{environment_name}/variables/{name}"
    ],
    updateHostedRunnerForOrg: [
      "PATCH /orgs/{org}/actions/hosted-runners/{hosted_runner_id}"
    ],
    updateOrgVariable: ["PATCH /orgs/{org}/actions/variables/{name}"],
    updateRepoVariable: [
      "PATCH /repos/{owner}/{repo}/actions/variables/{name}"
    ]
  },
  activity: {
    checkRepoIsStarredByAuthenticatedUser: ["GET /user/starred/{owner}/{repo}"],
    deleteRepoSubscription: ["DELETE /repos/{owner}/{repo}/subscription"],
    deleteThreadSubscription: [
      "DELETE /notifications/threads/{thread_id}/subscription"
    ],
    getFeeds: ["GET /feeds"],
    getRepoSubscription: ["GET /repos/{owner}/{repo}/subscription"],
    getThread: ["GET /notifications/threads/{thread_id}"],
    getThreadSubscriptionForAuthenticatedUser: [
      "GET /notifications/threads/{thread_id}/subscription"
    ],
    listEventsForAuthenticatedUser: ["GET /users/{username}/events"],
    listNotificationsForAuthenticatedUser: ["GET /notifications"],
    listOrgEventsForAuthenticatedUser: [
      "GET /users/{username}/events/orgs/{org}"
    ],
    listPublicEvents: ["GET /events"],
    listPublicEventsForRepoNetwork: ["GET /networks/{owner}/{repo}/events"],
    listPublicEventsForUser: ["GET /users/{username}/events/public"],
    listPublicOrgEvents: ["GET /orgs/{org}/events"],
    listReceivedEventsForUser: ["GET /users/{username}/received_events"],
    listReceivedPublicEventsForUser: [
      "GET /users/{username}/received_events/public"
    ],
    listRepoEvents: ["GET /repos/{owner}/{repo}/events"],
    listRepoNotificationsForAuthenticatedUser: [
      "GET /repos/{owner}/{repo}/notifications"
    ],
    listReposStarredByAuthenticatedUser: ["GET /user/starred"],
    listReposStarredByUser: ["GET /users/{username}/starred"],
    listReposWatchedByUser: ["GET /users/{username}/subscriptions"],
    listStargazersForRepo: ["GET /repos/{owner}/{repo}/stargazers"],
    listWatchedReposForAuthenticatedUser: ["GET /user/subscriptions"],
    listWatchersForRepo: ["GET /repos/{owner}/{repo}/subscribers"],
    markNotificationsAsRead: ["PUT /notifications"],
    markRepoNotificationsAsRead: ["PUT /repos/{owner}/{repo}/notifications"],
    markThreadAsDone: ["DELETE /notifications/threads/{thread_id}"],
    markThreadAsRead: ["PATCH /notifications/threads/{thread_id}"],
    setRepoSubscription: ["PUT /repos/{owner}/{repo}/subscription"],
    setThreadSubscription: [
      "PUT /notifications/threads/{thread_id}/subscription"
    ],
    starRepoForAuthenticatedUser: ["PUT /user/starred/{owner}/{repo}"],
    unstarRepoForAuthenticatedUser: ["DELETE /user/starred/{owner}/{repo}"]
  },
  apps: {
    addRepoToInstallation: [
      "PUT /user/installations/{installation_id}/repositories/{repository_id}",
      {},
      { renamed: ["apps", "addRepoToInstallationForAuthenticatedUser"] }
    ],
    addRepoToInstallationForAuthenticatedUser: [
      "PUT /user/installations/{installation_id}/repositories/{repository_id}"
    ],
    checkToken: ["POST /applications/{client_id}/token"],
    createFromManifest: ["POST /app-manifests/{code}/conversions"],
    createInstallationAccessToken: [
      "POST /app/installations/{installation_id}/access_tokens"
    ],
    deleteAuthorization: ["DELETE /applications/{client_id}/grant"],
    deleteInstallation: ["DELETE /app/installations/{installation_id}"],
    deleteToken: ["DELETE /applications/{client_id}/token"],
    getAuthenticated: ["GET /app"],
    getBySlug: ["GET /apps/{app_slug}"],
    getInstallation: ["GET /app/installations/{installation_id}"],
    getOrgInstallation: ["GET /orgs/{org}/installation"],
    getRepoInstallation: ["GET /repos/{owner}/{repo}/installation"],
    getSubscriptionPlanForAccount: [
      "GET /marketplace_listing/accounts/{account_id}"
    ],
    getSubscriptionPlanForAccountStubbed: [
      "GET /marketplace_listing/stubbed/accounts/{account_id}"
    ],
    getUserInstallation: ["GET /users/{username}/installation"],
    getWebhookConfigForApp: ["GET /app/hook/config"],
    getWebhookDelivery: ["GET /app/hook/deliveries/{delivery_id}"],
    listAccountsForPlan: ["GET /marketplace_listing/plans/{plan_id}/accounts"],
    listAccountsForPlanStubbed: [
      "GET /marketplace_listing/stubbed/plans/{plan_id}/accounts"
    ],
    listInstallationReposForAuthenticatedUser: [
      "GET /user/installations/{installation_id}/repositories"
    ],
    listInstallationRequestsForAuthenticatedApp: [
      "GET /app/installation-requests"
    ],
    listInstallations: ["GET /app/installations"],
    listInstallationsForAuthenticatedUser: ["GET /user/installations"],
    listPlans: ["GET /marketplace_listing/plans"],
    listPlansStubbed: ["GET /marketplace_listing/stubbed/plans"],
    listReposAccessibleToInstallation: ["GET /installation/repositories"],
    listSubscriptionsForAuthenticatedUser: ["GET /user/marketplace_purchases"],
    listSubscriptionsForAuthenticatedUserStubbed: [
      "GET /user/marketplace_purchases/stubbed"
    ],
    listWebhookDeliveries: ["GET /app/hook/deliveries"],
    redeliverWebhookDelivery: [
      "POST /app/hook/deliveries/{delivery_id}/attempts"
    ],
    removeRepoFromInstallation: [
      "DELETE /user/installations/{installation_id}/repositories/{repository_id}",
      {},
      { renamed: ["apps", "removeRepoFromInstallationForAuthenticatedUser"] }
    ],
    removeRepoFromInstallationForAuthenticatedUser: [
      "DELETE /user/installations/{installation_id}/repositories/{repository_id}"
    ],
    resetToken: ["PATCH /applications/{client_id}/token"],
    revokeInstallationAccessToken: ["DELETE /installation/token"],
    scopeToken: ["POST /applications/{client_id}/token/scoped"],
    suspendInstallation: ["PUT /app/installations/{installation_id}/suspended"],
    unsuspendInstallation: [
      "DELETE /app/installations/{installation_id}/suspended"
    ],
    updateWebhookConfigForApp: ["PATCH /app/hook/config"]
  },
  billing: {
    getGithubActionsBillingOrg: ["GET /orgs/{org}/settings/billing/actions"],
    getGithubActionsBillingUser: [
      "GET /users/{username}/settings/billing/actions"
    ],
    getGithubBillingPremiumRequestUsageReportOrg: [
      "GET /organizations/{org}/settings/billing/premium_request/usage"
    ],
    getGithubBillingPremiumRequestUsageReportUser: [
      "GET /users/{username}/settings/billing/premium_request/usage"
    ],
    getGithubBillingUsageReportOrg: [
      "GET /organizations/{org}/settings/billing/usage"
    ],
    getGithubBillingUsageReportUser: [
      "GET /users/{username}/settings/billing/usage"
    ],
    getGithubPackagesBillingOrg: ["GET /orgs/{org}/settings/billing/packages"],
    getGithubPackagesBillingUser: [
      "GET /users/{username}/settings/billing/packages"
    ],
    getSharedStorageBillingOrg: [
      "GET /orgs/{org}/settings/billing/shared-storage"
    ],
    getSharedStorageBillingUser: [
      "GET /users/{username}/settings/billing/shared-storage"
    ]
  },
  campaigns: {
    createCampaign: ["POST /orgs/{org}/campaigns"],
    deleteCampaign: ["DELETE /orgs/{org}/campaigns/{campaign_number}"],
    getCampaignSummary: ["GET /orgs/{org}/campaigns/{campaign_number}"],
    listOrgCampaigns: ["GET /orgs/{org}/campaigns"],
    updateCampaign: ["PATCH /orgs/{org}/campaigns/{campaign_number}"]
  },
  checks: {
    create: ["POST /repos/{owner}/{repo}/check-runs"],
    createSuite: ["POST /repos/{owner}/{repo}/check-suites"],
    get: ["GET /repos/{owner}/{repo}/check-runs/{check_run_id}"],
    getSuite: ["GET /repos/{owner}/{repo}/check-suites/{check_suite_id}"],
    listAnnotations: [
      "GET /repos/{owner}/{repo}/check-runs/{check_run_id}/annotations"
    ],
    listForRef: ["GET /repos/{owner}/{repo}/commits/{ref}/check-runs"],
    listForSuite: [
      "GET /repos/{owner}/{repo}/check-suites/{check_suite_id}/check-runs"
    ],
    listSuitesForRef: ["GET /repos/{owner}/{repo}/commits/{ref}/check-suites"],
    rerequestRun: [
      "POST /repos/{owner}/{repo}/check-runs/{check_run_id}/rerequest"
    ],
    rerequestSuite: [
      "POST /repos/{owner}/{repo}/check-suites/{check_suite_id}/rerequest"
    ],
    setSuitesPreferences: [
      "PATCH /repos/{owner}/{repo}/check-suites/preferences"
    ],
    update: ["PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}"]
  },
  codeScanning: {
    commitAutofix: [
      "POST /repos/{owner}/{repo}/code-scanning/alerts/{alert_number}/autofix/commits"
    ],
    createAutofix: [
      "POST /repos/{owner}/{repo}/code-scanning/alerts/{alert_number}/autofix"
    ],
    createVariantAnalysis: [
      "POST /repos/{owner}/{repo}/code-scanning/codeql/variant-analyses"
    ],
    deleteAnalysis: [
      "DELETE /repos/{owner}/{repo}/code-scanning/analyses/{analysis_id}{?confirm_delete}"
    ],
    deleteCodeqlDatabase: [
      "DELETE /repos/{owner}/{repo}/code-scanning/codeql/databases/{language}"
    ],
    getAlert: [
      "GET /repos/{owner}/{repo}/code-scanning/alerts/{alert_number}",
      {},
      { renamedParameters: { alert_id: "alert_number" } }
    ],
    getAnalysis: [
      "GET /repos/{owner}/{repo}/code-scanning/analyses/{analysis_id}"
    ],
    getAutofix: [
      "GET /repos/{owner}/{repo}/code-scanning/alerts/{alert_number}/autofix"
    ],
    getCodeqlDatabase: [
      "GET /repos/{owner}/{repo}/code-scanning/codeql/databases/{language}"
    ],
    getDefaultSetup: ["GET /repos/{owner}/{repo}/code-scanning/default-setup"],
    getSarif: ["GET /repos/{owner}/{repo}/code-scanning/sarifs/{sarif_id}"],
    getVariantAnalysis: [
      "GET /repos/{owner}/{repo}/code-scanning/codeql/variant-analyses/{codeql_variant_analysis_id}"
    ],
    getVariantAnalysisRepoTask: [
      "GET /repos/{owner}/{repo}/code-scanning/codeql/variant-analyses/{codeql_variant_analysis_id}/repos/{repo_owner}/{repo_name}"
    ],
    listAlertInstances: [
      "GET /repos/{owner}/{repo}/code-scanning/alerts/{alert_number}/instances"
    ],
    listAlertsForOrg: ["GET /orgs/{org}/code-scanning/alerts"],
    listAlertsForRepo: ["GET /repos/{owner}/{repo}/code-scanning/alerts"],
    listAlertsInstances: [
      "GET /repos/{owner}/{repo}/code-scanning/alerts/{alert_number}/instances",
      {},
      { renamed: ["codeScanning", "listAlertInstances"] }
    ],
    listCodeqlDatabases: [
      "GET /repos/{owner}/{repo}/code-scanning/codeql/databases"
    ],
    listRecentAnalyses: ["GET /repos/{owner}/{repo}/code-scanning/analyses"],
    updateAlert: [
      "PATCH /repos/{owner}/{repo}/code-scanning/alerts/{alert_number}"
    ],
    updateDefaultSetup: [
      "PATCH /repos/{owner}/{repo}/code-scanning/default-setup"
    ],
    uploadSarif: ["POST /repos/{owner}/{repo}/code-scanning/sarifs"]
  },
  codeSecurity: {
    attachConfiguration: [
      "POST /orgs/{org}/code-security/configurations/{configuration_id}/attach"
    ],
    attachEnterpriseConfiguration: [
      "POST /enterprises/{enterprise}/code-security/configurations/{configuration_id}/attach"
    ],
    createConfiguration: ["POST /orgs/{org}/code-security/configurations"],
    createConfigurationForEnterprise: [
      "POST /enterprises/{enterprise}/code-security/configurations"
    ],
    deleteConfiguration: [
      "DELETE /orgs/{org}/code-security/configurations/{configuration_id}"
    ],
    deleteConfigurationForEnterprise: [
      "DELETE /enterprises/{enterprise}/code-security/configurations/{configuration_id}"
    ],
    detachConfiguration: [
      "DELETE /orgs/{org}/code-security/configurations/detach"
    ],
    getConfiguration: [
      "GET /orgs/{org}/code-security/configurations/{configuration_id}"
    ],
    getConfigurationForRepository: [
      "GET /repos/{owner}/{repo}/code-security-configuration"
    ],
    getConfigurationsForEnterprise: [
      "GET /enterprises/{enterprise}/code-security/configurations"
    ],
    getConfigurationsForOrg: ["GET /orgs/{org}/code-security/configurations"],
    getDefaultConfigurations: [
      "GET /orgs/{org}/code-security/configurations/defaults"
    ],
    getDefaultConfigurationsForEnterprise: [
      "GET /enterprises/{enterprise}/code-security/configurations/defaults"
    ],
    getRepositoriesForConfiguration: [
      "GET /orgs/{org}/code-security/configurations/{configuration_id}/repositories"
    ],
    getRepositoriesForEnterpriseConfiguration: [
      "GET /enterprises/{enterprise}/code-security/configurations/{configuration_id}/repositories"
    ],
    getSingleConfigurationForEnterprise: [
      "GET /enterprises/{enterprise}/code-security/configurations/{configuration_id}"
    ],
    setConfigurationAsDefault: [
      "PUT /orgs/{org}/code-security/configurations/{configuration_id}/defaults"
    ],
    setConfigurationAsDefaultForEnterprise: [
      "PUT /enterprises/{enterprise}/code-security/configurations/{configuration_id}/defaults"
    ],
    updateConfiguration: [
      "PATCH /orgs/{org}/code-security/configurations/{configuration_id}"
    ],
    updateEnterpriseConfiguration: [
      "PATCH /enterprises/{enterprise}/code-security/configurations/{configuration_id}"
    ]
  },
  codesOfConduct: {
    getAllCodesOfConduct: ["GET /codes_of_conduct"],
    getConductCode: ["GET /codes_of_conduct/{key}"]
  },
  codespaces: {
    addRepositoryForSecretForAuthenticatedUser: [
      "PUT /user/codespaces/secrets/{secret_name}/repositories/{repository_id}"
    ],
    addSelectedRepoToOrgSecret: [
      "PUT /orgs/{org}/codespaces/secrets/{secret_name}/repositories/{repository_id}"
    ],
    checkPermissionsForDevcontainer: [
      "GET /repos/{owner}/{repo}/codespaces/permissions_check"
    ],
    codespaceMachinesForAuthenticatedUser: [
      "GET /user/codespaces/{codespace_name}/machines"
    ],
    createForAuthenticatedUser: ["POST /user/codespaces"],
    createOrUpdateOrgSecret: [
      "PUT /orgs/{org}/codespaces/secrets/{secret_name}"
    ],
    createOrUpdateRepoSecret: [
      "PUT /repos/{owner}/{repo}/codespaces/secrets/{secret_name}"
    ],
    createOrUpdateSecretForAuthenticatedUser: [
      "PUT /user/codespaces/secrets/{secret_name}"
    ],
    createWithPrForAuthenticatedUser: [
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/codespaces"
    ],
    createWithRepoForAuthenticatedUser: [
      "POST /repos/{owner}/{repo}/codespaces"
    ],
    deleteForAuthenticatedUser: ["DELETE /user/codespaces/{codespace_name}"],
    deleteFromOrganization: [
      "DELETE /orgs/{org}/members/{username}/codespaces/{codespace_name}"
    ],
    deleteOrgSecret: ["DELETE /orgs/{org}/codespaces/secrets/{secret_name}"],
    deleteRepoSecret: [
      "DELETE /repos/{owner}/{repo}/codespaces/secrets/{secret_name}"
    ],
    deleteSecretForAuthenticatedUser: [
      "DELETE /user/codespaces/secrets/{secret_name}"
    ],
    exportForAuthenticatedUser: [
      "POST /user/codespaces/{codespace_name}/exports"
    ],
    getCodespacesForUserInOrg: [
      "GET /orgs/{org}/members/{username}/codespaces"
    ],
    getExportDetailsForAuthenticatedUser: [
      "GET /user/codespaces/{codespace_name}/exports/{export_id}"
    ],
    getForAuthenticatedUser: ["GET /user/codespaces/{codespace_name}"],
    getOrgPublicKey: ["GET /orgs/{org}/codespaces/secrets/public-key"],
    getOrgSecret: ["GET /orgs/{org}/codespaces/secrets/{secret_name}"],
    getPublicKeyForAuthenticatedUser: [
      "GET /user/codespaces/secrets/public-key"
    ],
    getRepoPublicKey: [
      "GET /repos/{owner}/{repo}/codespaces/secrets/public-key"
    ],
    getRepoSecret: [
      "GET /repos/{owner}/{repo}/codespaces/secrets/{secret_name}"
    ],
    getSecretForAuthenticatedUser: [
      "GET /user/codespaces/secrets/{secret_name}"
    ],
    listDevcontainersInRepositoryForAuthenticatedUser: [
      "GET /repos/{owner}/{repo}/codespaces/devcontainers"
    ],
    listForAuthenticatedUser: ["GET /user/codespaces"],
    listInOrganization: [
      "GET /orgs/{org}/codespaces",
      {},
      { renamedParameters: { org_id: "org" } }
    ],
    listInRepositoryForAuthenticatedUser: [
      "GET /repos/{owner}/{repo}/codespaces"
    ],
    listOrgSecrets: ["GET /orgs/{org}/codespaces/secrets"],
    listRepoSecrets: ["GET /repos/{owner}/{repo}/codespaces/secrets"],
    listRepositoriesForSecretForAuthenticatedUser: [
      "GET /user/codespaces/secrets/{secret_name}/repositories"
    ],
    listSecretsForAuthenticatedUser: ["GET /user/codespaces/secrets"],
    listSelectedReposForOrgSecret: [
      "GET /orgs/{org}/codespaces/secrets/{secret_name}/repositories"
    ],
    preFlightWithRepoForAuthenticatedUser: [
      "GET /repos/{owner}/{repo}/codespaces/new"
    ],
    publishForAuthenticatedUser: [
      "POST /user/codespaces/{codespace_name}/publish"
    ],
    removeRepositoryForSecretForAuthenticatedUser: [
      "DELETE /user/codespaces/secrets/{secret_name}/repositories/{repository_id}"
    ],
    removeSelectedRepoFromOrgSecret: [
      "DELETE /orgs/{org}/codespaces/secrets/{secret_name}/repositories/{repository_id}"
    ],
    repoMachinesForAuthenticatedUser: [
      "GET /repos/{owner}/{repo}/codespaces/machines"
    ],
    setRepositoriesForSecretForAuthenticatedUser: [
      "PUT /user/codespaces/secrets/{secret_name}/repositories"
    ],
    setSelectedReposForOrgSecret: [
      "PUT /orgs/{org}/codespaces/secrets/{secret_name}/repositories"
    ],
    startForAuthenticatedUser: ["POST /user/codespaces/{codespace_name}/start"],
    stopForAuthenticatedUser: ["POST /user/codespaces/{codespace_name}/stop"],
    stopInOrganization: [
      "POST /orgs/{org}/members/{username}/codespaces/{codespace_name}/stop"
    ],
    updateForAuthenticatedUser: ["PATCH /user/codespaces/{codespace_name}"]
  },
  copilot: {
    addCopilotSeatsForTeams: [
      "POST /orgs/{org}/copilot/billing/selected_teams"
    ],
    addCopilotSeatsForUsers: [
      "POST /orgs/{org}/copilot/billing/selected_users"
    ],
    cancelCopilotSeatAssignmentForTeams: [
      "DELETE /orgs/{org}/copilot/billing/selected_teams"
    ],
    cancelCopilotSeatAssignmentForUsers: [
      "DELETE /orgs/{org}/copilot/billing/selected_users"
    ],
    copilotMetricsForOrganization: ["GET /orgs/{org}/copilot/metrics"],
    copilotMetricsForTeam: ["GET /orgs/{org}/team/{team_slug}/copilot/metrics"],
    getCopilotOrganizationDetails: ["GET /orgs/{org}/copilot/billing"],
    getCopilotSeatDetailsForUser: [
      "GET /orgs/{org}/members/{username}/copilot"
    ],
    listCopilotSeats: ["GET /orgs/{org}/copilot/billing/seats"]
  },
  credentials: { revoke: ["POST /credentials/revoke"] },
  dependabot: {
    addSelectedRepoToOrgSecret: [
      "PUT /orgs/{org}/dependabot/secrets/{secret_name}/repositories/{repository_id}"
    ],
    createOrUpdateOrgSecret: [
      "PUT /orgs/{org}/dependabot/secrets/{secret_name}"
    ],
    createOrUpdateRepoSecret: [
      "PUT /repos/{owner}/{repo}/dependabot/secrets/{secret_name}"
    ],
    deleteOrgSecret: ["DELETE /orgs/{org}/dependabot/secrets/{secret_name}"],
    deleteRepoSecret: [
      "DELETE /repos/{owner}/{repo}/dependabot/secrets/{secret_name}"
    ],
    getAlert: ["GET /repos/{owner}/{repo}/dependabot/alerts/{alert_number}"],
    getOrgPublicKey: ["GET /orgs/{org}/dependabot/secrets/public-key"],
    getOrgSecret: ["GET /orgs/{org}/dependabot/secrets/{secret_name}"],
    getRepoPublicKey: [
      "GET /repos/{owner}/{repo}/dependabot/secrets/public-key"
    ],
    getRepoSecret: [
      "GET /repos/{owner}/{repo}/dependabot/secrets/{secret_name}"
    ],
    listAlertsForEnterprise: [
      "GET /enterprises/{enterprise}/dependabot/alerts"
    ],
    listAlertsForOrg: ["GET /orgs/{org}/dependabot/alerts"],
    listAlertsForRepo: ["GET /repos/{owner}/{repo}/dependabot/alerts"],
    listOrgSecrets: ["GET /orgs/{org}/dependabot/secrets"],
    listRepoSecrets: ["GET /repos/{owner}/{repo}/dependabot/secrets"],
    listSelectedReposForOrgSecret: [
      "GET /orgs/{org}/dependabot/secrets/{secret_name}/repositories"
    ],
    removeSelectedRepoFromOrgSecret: [
      "DELETE /orgs/{org}/dependabot/secrets/{secret_name}/repositories/{repository_id}"
    ],
    repositoryAccessForOrg: [
      "GET /organizations/{org}/dependabot/repository-access"
    ],
    setRepositoryAccessDefaultLevel: [
      "PUT /organizations/{org}/dependabot/repository-access/default-level"
    ],
    setSelectedReposForOrgSecret: [
      "PUT /orgs/{org}/dependabot/secrets/{secret_name}/repositories"
    ],
    updateAlert: [
      "PATCH /repos/{owner}/{repo}/dependabot/alerts/{alert_number}"
    ],
    updateRepositoryAccessForOrg: [
      "PATCH /organizations/{org}/dependabot/repository-access"
    ]
  },
  dependencyGraph: {
    createRepositorySnapshot: [
      "POST /repos/{owner}/{repo}/dependency-graph/snapshots"
    ],
    diffRange: [
      "GET /repos/{owner}/{repo}/dependency-graph/compare/{basehead}"
    ],
    exportSbom: ["GET /repos/{owner}/{repo}/dependency-graph/sbom"]
  },
  emojis: { get: ["GET /emojis"] },
  enterpriseTeamMemberships: {
    add: [
      "PUT /enterprises/{enterprise}/teams/{enterprise-team}/memberships/{username}"
    ],
    bulkAdd: [
      "POST /enterprises/{enterprise}/teams/{enterprise-team}/memberships/add"
    ],
    bulkRemove: [
      "POST /enterprises/{enterprise}/teams/{enterprise-team}/memberships/remove"
    ],
    get: [
      "GET /enterprises/{enterprise}/teams/{enterprise-team}/memberships/{username}"
    ],
    list: ["GET /enterprises/{enterprise}/teams/{enterprise-team}/memberships"],
    remove: [
      "DELETE /enterprises/{enterprise}/teams/{enterprise-team}/memberships/{username}"
    ]
  },
  enterpriseTeamOrganizations: {
    add: [
      "PUT /enterprises/{enterprise}/teams/{enterprise-team}/organizations/{org}"
    ],
    bulkAdd: [
      "POST /enterprises/{enterprise}/teams/{enterprise-team}/organizations/add"
    ],
    bulkRemove: [
      "POST /enterprises/{enterprise}/teams/{enterprise-team}/organizations/remove"
    ],
    delete: [
      "DELETE /enterprises/{enterprise}/teams/{enterprise-team}/organizations/{org}"
    ],
    getAssignment: [
      "GET /enterprises/{enterprise}/teams/{enterprise-team}/organizations/{org}"
    ],
    getAssignments: [
      "GET /enterprises/{enterprise}/teams/{enterprise-team}/organizations"
    ]
  },
  enterpriseTeams: {
    create: ["POST /enterprises/{enterprise}/teams"],
    delete: ["DELETE /enterprises/{enterprise}/teams/{team_slug}"],
    get: ["GET /enterprises/{enterprise}/teams/{team_slug}"],
    list: ["GET /enterprises/{enterprise}/teams"],
    update: ["PATCH /enterprises/{enterprise}/teams/{team_slug}"]
  },
  gists: {
    checkIsStarred: ["GET /gists/{gist_id}/star"],
    create: ["POST /gists"],
    createComment: ["POST /gists/{gist_id}/comments"],
    delete: ["DELETE /gists/{gist_id}"],
    deleteComment: ["DELETE /gists/{gist_id}/comments/{comment_id}"],
    fork: ["POST /gists/{gist_id}/forks"],
    get: ["GET /gists/{gist_id}"],
    getComment: ["GET /gists/{gist_id}/comments/{comment_id}"],
    getRevision: ["GET /gists/{gist_id}/{sha}"],
    list: ["GET /gists"],
    listComments: ["GET /gists/{gist_id}/comments"],
    listCommits: ["GET /gists/{gist_id}/commits"],
    listForUser: ["GET /users/{username}/gists"],
    listForks: ["GET /gists/{gist_id}/forks"],
    listPublic: ["GET /gists/public"],
    listStarred: ["GET /gists/starred"],
    star: ["PUT /gists/{gist_id}/star"],
    unstar: ["DELETE /gists/{gist_id}/star"],
    update: ["PATCH /gists/{gist_id}"],
    updateComment: ["PATCH /gists/{gist_id}/comments/{comment_id}"]
  },
  git: {
    createBlob: ["POST /repos/{owner}/{repo}/git/blobs"],
    createCommit: ["POST /repos/{owner}/{repo}/git/commits"],
    createRef: ["POST /repos/{owner}/{repo}/git/refs"],
    createTag: ["POST /repos/{owner}/{repo}/git/tags"],
    createTree: ["POST /repos/{owner}/{repo}/git/trees"],
    deleteRef: ["DELETE /repos/{owner}/{repo}/git/refs/{ref}"],
    getBlob: ["GET /repos/{owner}/{repo}/git/blobs/{file_sha}"],
    getCommit: ["GET /repos/{owner}/{repo}/git/commits/{commit_sha}"],
    getRef: ["GET /repos/{owner}/{repo}/git/ref/{ref}"],
    getTag: ["GET /repos/{owner}/{repo}/git/tags/{tag_sha}"],
    getTree: ["GET /repos/{owner}/{repo}/git/trees/{tree_sha}"],
    listMatchingRefs: ["GET /repos/{owner}/{repo}/git/matching-refs/{ref}"],
    updateRef: ["PATCH /repos/{owner}/{repo}/git/refs/{ref}"]
  },
  gitignore: {
    getAllTemplates: ["GET /gitignore/templates"],
    getTemplate: ["GET /gitignore/templates/{name}"]
  },
  hostedCompute: {
    createNetworkConfigurationForOrg: [
      "POST /orgs/{org}/settings/network-configurations"
    ],
    deleteNetworkConfigurationFromOrg: [
      "DELETE /orgs/{org}/settings/network-configurations/{network_configuration_id}"
    ],
    getNetworkConfigurationForOrg: [
      "GET /orgs/{org}/settings/network-configurations/{network_configuration_id}"
    ],
    getNetworkSettingsForOrg: [
      "GET /orgs/{org}/settings/network-settings/{network_settings_id}"
    ],
    listNetworkConfigurationsForOrg: [
      "GET /orgs/{org}/settings/network-configurations"
    ],
    updateNetworkConfigurationForOrg: [
      "PATCH /orgs/{org}/settings/network-configurations/{network_configuration_id}"
    ]
  },
  interactions: {
    getRestrictionsForAuthenticatedUser: ["GET /user/interaction-limits"],
    getRestrictionsForOrg: ["GET /orgs/{org}/interaction-limits"],
    getRestrictionsForRepo: ["GET /repos/{owner}/{repo}/interaction-limits"],
    getRestrictionsForYourPublicRepos: [
      "GET /user/interaction-limits",
      {},
      { renamed: ["interactions", "getRestrictionsForAuthenticatedUser"] }
    ],
    removeRestrictionsForAuthenticatedUser: ["DELETE /user/interaction-limits"],
    removeRestrictionsForOrg: ["DELETE /orgs/{org}/interaction-limits"],
    removeRestrictionsForRepo: [
      "DELETE /repos/{owner}/{repo}/interaction-limits"
    ],
    removeRestrictionsForYourPublicRepos: [
      "DELETE /user/interaction-limits",
      {},
      { renamed: ["interactions", "removeRestrictionsForAuthenticatedUser"] }
    ],
    setRestrictionsForAuthenticatedUser: ["PUT /user/interaction-limits"],
    setRestrictionsForOrg: ["PUT /orgs/{org}/interaction-limits"],
    setRestrictionsForRepo: ["PUT /repos/{owner}/{repo}/interaction-limits"],
    setRestrictionsForYourPublicRepos: [
      "PUT /user/interaction-limits",
      {},
      { renamed: ["interactions", "setRestrictionsForAuthenticatedUser"] }
    ]
  },
  issues: {
    addAssignees: [
      "POST /repos/{owner}/{repo}/issues/{issue_number}/assignees"
    ],
    addBlockedByDependency: [
      "POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by"
    ],
    addLabels: ["POST /repos/{owner}/{repo}/issues/{issue_number}/labels"],
    addSubIssue: [
      "POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues"
    ],
    checkUserCanBeAssigned: ["GET /repos/{owner}/{repo}/assignees/{assignee}"],
    checkUserCanBeAssignedToIssue: [
      "GET /repos/{owner}/{repo}/issues/{issue_number}/assignees/{assignee}"
    ],
    create: ["POST /repos/{owner}/{repo}/issues"],
    createComment: [
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments"
    ],
    createLabel: ["POST /repos/{owner}/{repo}/labels"],
    createMilestone: ["POST /repos/{owner}/{repo}/milestones"],
    deleteComment: [
      "DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}"
    ],
    deleteLabel: ["DELETE /repos/{owner}/{repo}/labels/{name}"],
    deleteMilestone: [
      "DELETE /repos/{owner}/{repo}/milestones/{milestone_number}"
    ],
    get: ["GET /repos/{owner}/{repo}/issues/{issue_number}"],
    getComment: ["GET /repos/{owner}/{repo}/issues/comments/{comment_id}"],
    getEvent: ["GET /repos/{owner}/{repo}/issues/events/{event_id}"],
    getLabel: ["GET /repos/{owner}/{repo}/labels/{name}"],
    getMilestone: ["GET /repos/{owner}/{repo}/milestones/{milestone_number}"],
    getParent: ["GET /repos/{owner}/{repo}/issues/{issue_number}/parent"],
    list: ["GET /issues"],
    listAssignees: ["GET /repos/{owner}/{repo}/assignees"],
    listComments: ["GET /repos/{owner}/{repo}/issues/{issue_number}/comments"],
    listCommentsForRepo: ["GET /repos/{owner}/{repo}/issues/comments"],
    listDependenciesBlockedBy: [
      "GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by"
    ],
    listDependenciesBlocking: [
      "GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocking"
    ],
    listEvents: ["GET /repos/{owner}/{repo}/issues/{issue_number}/events"],
    listEventsForRepo: ["GET /repos/{owner}/{repo}/issues/events"],
    listEventsForTimeline: [
      "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline"
    ],
    listForAuthenticatedUser: ["GET /user/issues"],
    listForOrg: ["GET /orgs/{org}/issues"],
    listForRepo: ["GET /repos/{owner}/{repo}/issues"],
    listLabelsForMilestone: [
      "GET /repos/{owner}/{repo}/milestones/{milestone_number}/labels"
    ],
    listLabelsForRepo: ["GET /repos/{owner}/{repo}/labels"],
    listLabelsOnIssue: [
      "GET /repos/{owner}/{repo}/issues/{issue_number}/labels"
    ],
    listMilestones: ["GET /repos/{owner}/{repo}/milestones"],
    listSubIssues: [
      "GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues"
    ],
    lock: ["PUT /repos/{owner}/{repo}/issues/{issue_number}/lock"],
    removeAllLabels: [
      "DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels"
    ],
    removeAssignees: [
      "DELETE /repos/{owner}/{repo}/issues/{issue_number}/assignees"
    ],
    removeDependencyBlockedBy: [
      "DELETE /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by/{issue_id}"
    ],
    removeLabel: [
      "DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}"
    ],
    removeSubIssue: [
      "DELETE /repos/{owner}/{repo}/issues/{issue_number}/sub_issue"
    ],
    reprioritizeSubIssue: [
      "PATCH /repos/{owner}/{repo}/issues/{issue_number}/sub_issues/priority"
    ],
    setLabels: ["PUT /repos/{owner}/{repo}/issues/{issue_number}/labels"],
    unlock: ["DELETE /repos/{owner}/{repo}/issues/{issue_number}/lock"],
    update: ["PATCH /repos/{owner}/{repo}/issues/{issue_number}"],
    updateComment: ["PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}"],
    updateLabel: ["PATCH /repos/{owner}/{repo}/labels/{name}"],
    updateMilestone: [
      "PATCH /repos/{owner}/{repo}/milestones/{milestone_number}"
    ]
  },
  licenses: {
    get: ["GET /licenses/{license}"],
    getAllCommonlyUsed: ["GET /licenses"],
    getForRepo: ["GET /repos/{owner}/{repo}/license"]
  },
  markdown: {
    render: ["POST /markdown"],
    renderRaw: [
      "POST /markdown/raw",
      { headers: { "content-type": "text/plain; charset=utf-8" } }
    ]
  },
  meta: {
    get: ["GET /meta"],
    getAllVersions: ["GET /versions"],
    getOctocat: ["GET /octocat"],
    getZen: ["GET /zen"],
    root: ["GET /"]
  },
  migrations: {
    deleteArchiveForAuthenticatedUser: [
      "DELETE /user/migrations/{migration_id}/archive"
    ],
    deleteArchiveForOrg: [
      "DELETE /orgs/{org}/migrations/{migration_id}/archive"
    ],
    downloadArchiveForOrg: [
      "GET /orgs/{org}/migrations/{migration_id}/archive"
    ],
    getArchiveForAuthenticatedUser: [
      "GET /user/migrations/{migration_id}/archive"
    ],
    getStatusForAuthenticatedUser: ["GET /user/migrations/{migration_id}"],
    getStatusForOrg: ["GET /orgs/{org}/migrations/{migration_id}"],
    listForAuthenticatedUser: ["GET /user/migrations"],
    listForOrg: ["GET /orgs/{org}/migrations"],
    listReposForAuthenticatedUser: [
      "GET /user/migrations/{migration_id}/repositories"
    ],
    listReposForOrg: ["GET /orgs/{org}/migrations/{migration_id}/repositories"],
    listReposForUser: [
      "GET /user/migrations/{migration_id}/repositories",
      {},
      { renamed: ["migrations", "listReposForAuthenticatedUser"] }
    ],
    startForAuthenticatedUser: ["POST /user/migrations"],
    startForOrg: ["POST /orgs/{org}/migrations"],
    unlockRepoForAuthenticatedUser: [
      "DELETE /user/migrations/{migration_id}/repos/{repo_name}/lock"
    ],
    unlockRepoForOrg: [
      "DELETE /orgs/{org}/migrations/{migration_id}/repos/{repo_name}/lock"
    ]
  },
  oidc: {
    getOidcCustomSubTemplateForOrg: [
      "GET /orgs/{org}/actions/oidc/customization/sub"
    ],
    updateOidcCustomSubTemplateForOrg: [
      "PUT /orgs/{org}/actions/oidc/customization/sub"
    ]
  },
  orgs: {
    addSecurityManagerTeam: [
      "PUT /orgs/{org}/security-managers/teams/{team_slug}",
      {},
      {
        deprecated: "octokit.rest.orgs.addSecurityManagerTeam() is deprecated, see https://docs.github.com/rest/orgs/security-managers#add-a-security-manager-team"
      }
    ],
    assignTeamToOrgRole: [
      "PUT /orgs/{org}/organization-roles/teams/{team_slug}/{role_id}"
    ],
    assignUserToOrgRole: [
      "PUT /orgs/{org}/organization-roles/users/{username}/{role_id}"
    ],
    blockUser: ["PUT /orgs/{org}/blocks/{username}"],
    cancelInvitation: ["DELETE /orgs/{org}/invitations/{invitation_id}"],
    checkBlockedUser: ["GET /orgs/{org}/blocks/{username}"],
    checkMembershipForUser: ["GET /orgs/{org}/members/{username}"],
    checkPublicMembershipForUser: ["GET /orgs/{org}/public_members/{username}"],
    convertMemberToOutsideCollaborator: [
      "PUT /orgs/{org}/outside_collaborators/{username}"
    ],
    createArtifactStorageRecord: [
      "POST /orgs/{org}/artifacts/metadata/storage-record"
    ],
    createInvitation: ["POST /orgs/{org}/invitations"],
    createIssueType: ["POST /orgs/{org}/issue-types"],
    createWebhook: ["POST /orgs/{org}/hooks"],
    customPropertiesForOrgsCreateOrUpdateOrganizationValues: [
      "PATCH /organizations/{org}/org-properties/values"
    ],
    customPropertiesForOrgsGetOrganizationValues: [
      "GET /organizations/{org}/org-properties/values"
    ],
    customPropertiesForReposCreateOrUpdateOrganizationDefinition: [
      "PUT /orgs/{org}/properties/schema/{custom_property_name}"
    ],
    customPropertiesForReposCreateOrUpdateOrganizationDefinitions: [
      "PATCH /orgs/{org}/properties/schema"
    ],
    customPropertiesForReposCreateOrUpdateOrganizationValues: [
      "PATCH /orgs/{org}/properties/values"
    ],
    customPropertiesForReposDeleteOrganizationDefinition: [
      "DELETE /orgs/{org}/properties/schema/{custom_property_name}"
    ],
    customPropertiesForReposGetOrganizationDefinition: [
      "GET /orgs/{org}/properties/schema/{custom_property_name}"
    ],
    customPropertiesForReposGetOrganizationDefinitions: [
      "GET /orgs/{org}/properties/schema"
    ],
    customPropertiesForReposGetOrganizationValues: [
      "GET /orgs/{org}/properties/values"
    ],
    delete: ["DELETE /orgs/{org}"],
    deleteAttestationsBulk: ["POST /orgs/{org}/attestations/delete-request"],
    deleteAttestationsById: [
      "DELETE /orgs/{org}/attestations/{attestation_id}"
    ],
    deleteAttestationsBySubjectDigest: [
      "DELETE /orgs/{org}/attestations/digest/{subject_digest}"
    ],
    deleteIssueType: ["DELETE /orgs/{org}/issue-types/{issue_type_id}"],
    deleteWebhook: ["DELETE /orgs/{org}/hooks/{hook_id}"],
    disableSelectedRepositoryImmutableReleasesOrganization: [
      "DELETE /orgs/{org}/settings/immutable-releases/repositories/{repository_id}"
    ],
    enableSelectedRepositoryImmutableReleasesOrganization: [
      "PUT /orgs/{org}/settings/immutable-releases/repositories/{repository_id}"
    ],
    get: ["GET /orgs/{org}"],
    getImmutableReleasesSettings: [
      "GET /orgs/{org}/settings/immutable-releases"
    ],
    getImmutableReleasesSettingsRepositories: [
      "GET /orgs/{org}/settings/immutable-releases/repositories"
    ],
    getMembershipForAuthenticatedUser: ["GET /user/memberships/orgs/{org}"],
    getMembershipForUser: ["GET /orgs/{org}/memberships/{username}"],
    getOrgRole: ["GET /orgs/{org}/organization-roles/{role_id}"],
    getOrgRulesetHistory: ["GET /orgs/{org}/rulesets/{ruleset_id}/history"],
    getOrgRulesetVersion: [
      "GET /orgs/{org}/rulesets/{ruleset_id}/history/{version_id}"
    ],
    getWebhook: ["GET /orgs/{org}/hooks/{hook_id}"],
    getWebhookConfigForOrg: ["GET /orgs/{org}/hooks/{hook_id}/config"],
    getWebhookDelivery: [
      "GET /orgs/{org}/hooks/{hook_id}/deliveries/{delivery_id}"
    ],
    list: ["GET /organizations"],
    listAppInstallations: ["GET /orgs/{org}/installations"],
    listArtifactStorageRecords: [
      "GET /orgs/{org}/artifacts/{subject_digest}/metadata/storage-records"
    ],
    listAttestationRepositories: ["GET /orgs/{org}/attestations/repositories"],
    listAttestations: ["GET /orgs/{org}/attestations/{subject_digest}"],
    listAttestationsBulk: [
      "POST /orgs/{org}/attestations/bulk-list{?per_page,before,after}"
    ],
    listBlockedUsers: ["GET /orgs/{org}/blocks"],
    listFailedInvitations: ["GET /orgs/{org}/failed_invitations"],
    listForAuthenticatedUser: ["GET /user/orgs"],
    listForUser: ["GET /users/{username}/orgs"],
    listInvitationTeams: ["GET /orgs/{org}/invitations/{invitation_id}/teams"],
    listIssueTypes: ["GET /orgs/{org}/issue-types"],
    listMembers: ["GET /orgs/{org}/members"],
    listMembershipsForAuthenticatedUser: ["GET /user/memberships/orgs"],
    listOrgRoleTeams: ["GET /orgs/{org}/organization-roles/{role_id}/teams"],
    listOrgRoleUsers: ["GET /orgs/{org}/organization-roles/{role_id}/users"],
    listOrgRoles: ["GET /orgs/{org}/organization-roles"],
    listOrganizationFineGrainedPermissions: [
      "GET /orgs/{org}/organization-fine-grained-permissions"
    ],
    listOutsideCollaborators: ["GET /orgs/{org}/outside_collaborators"],
    listPatGrantRepositories: [
      "GET /orgs/{org}/personal-access-tokens/{pat_id}/repositories"
    ],
    listPatGrantRequestRepositories: [
      "GET /orgs/{org}/personal-access-token-requests/{pat_request_id}/repositories"
    ],
    listPatGrantRequests: ["GET /orgs/{org}/personal-access-token-requests"],
    listPatGrants: ["GET /orgs/{org}/personal-access-tokens"],
    listPendingInvitations: ["GET /orgs/{org}/invitations"],
    listPublicMembers: ["GET /orgs/{org}/public_members"],
    listSecurityManagerTeams: [
      "GET /orgs/{org}/security-managers",
      {},
      {
        deprecated: "octokit.rest.orgs.listSecurityManagerTeams() is deprecated, see https://docs.github.com/rest/orgs/security-managers#list-security-manager-teams"
      }
    ],
    listWebhookDeliveries: ["GET /orgs/{org}/hooks/{hook_id}/deliveries"],
    listWebhooks: ["GET /orgs/{org}/hooks"],
    pingWebhook: ["POST /orgs/{org}/hooks/{hook_id}/pings"],
    redeliverWebhookDelivery: [
      "POST /orgs/{org}/hooks/{hook_id}/deliveries/{delivery_id}/attempts"
    ],
    removeMember: ["DELETE /orgs/{org}/members/{username}"],
    removeMembershipForUser: ["DELETE /orgs/{org}/memberships/{username}"],
    removeOutsideCollaborator: [
      "DELETE /orgs/{org}/outside_collaborators/{username}"
    ],
    removePublicMembershipForAuthenticatedUser: [
      "DELETE /orgs/{org}/public_members/{username}"
    ],
    removeSecurityManagerTeam: [
      "DELETE /orgs/{org}/security-managers/teams/{team_slug}",
      {},
      {
        deprecated: "octokit.rest.orgs.removeSecurityManagerTeam() is deprecated, see https://docs.github.com/rest/orgs/security-managers#remove-a-security-manager-team"
      }
    ],
    reviewPatGrantRequest: [
      "POST /orgs/{org}/personal-access-token-requests/{pat_request_id}"
    ],
    reviewPatGrantRequestsInBulk: [
      "POST /orgs/{org}/personal-access-token-requests"
    ],
    revokeAllOrgRolesTeam: [
      "DELETE /orgs/{org}/organization-roles/teams/{team_slug}"
    ],
    revokeAllOrgRolesUser: [
      "DELETE /orgs/{org}/organization-roles/users/{username}"
    ],
    revokeOrgRoleTeam: [
      "DELETE /orgs/{org}/organization-roles/teams/{team_slug}/{role_id}"
    ],
    revokeOrgRoleUser: [
      "DELETE /orgs/{org}/organization-roles/users/{username}/{role_id}"
    ],
    setImmutableReleasesSettings: [
      "PUT /orgs/{org}/settings/immutable-releases"
    ],
    setImmutableReleasesSettingsRepositories: [
      "PUT /orgs/{org}/settings/immutable-releases/repositories"
    ],
    setMembershipForUser: ["PUT /orgs/{org}/memberships/{username}"],
    setPublicMembershipForAuthenticatedUser: [
      "PUT /orgs/{org}/public_members/{username}"
    ],
    unblockUser: ["DELETE /orgs/{org}/blocks/{username}"],
    update: ["PATCH /orgs/{org}"],
    updateIssueType: ["PUT /orgs/{org}/issue-types/{issue_type_id}"],
    updateMembershipForAuthenticatedUser: [
      "PATCH /user/memberships/orgs/{org}"
    ],
    updatePatAccess: ["POST /orgs/{org}/personal-access-tokens/{pat_id}"],
    updatePatAccesses: ["POST /orgs/{org}/personal-access-tokens"],
    updateWebhook: ["PATCH /orgs/{org}/hooks/{hook_id}"],
    updateWebhookConfigForOrg: ["PATCH /orgs/{org}/hooks/{hook_id}/config"]
  },
  packages: {
    deletePackageForAuthenticatedUser: [
      "DELETE /user/packages/{package_type}/{package_name}"
    ],
    deletePackageForOrg: [
      "DELETE /orgs/{org}/packages/{package_type}/{package_name}"
    ],
    deletePackageForUser: [
      "DELETE /users/{username}/packages/{package_type}/{package_name}"
    ],
    deletePackageVersionForAuthenticatedUser: [
      "DELETE /user/packages/{package_type}/{package_name}/versions/{package_version_id}"
    ],
    deletePackageVersionForOrg: [
      "DELETE /orgs/{org}/packages/{package_type}/{package_name}/versions/{package_version_id}"
    ],
    deletePackageVersionForUser: [
      "DELETE /users/{username}/packages/{package_type}/{package_name}/versions/{package_version_id}"
    ],
    getAllPackageVersionsForAPackageOwnedByAnOrg: [
      "GET /orgs/{org}/packages/{package_type}/{package_name}/versions",
      {},
      { renamed: ["packages", "getAllPackageVersionsForPackageOwnedByOrg"] }
    ],
    getAllPackageVersionsForAPackageOwnedByTheAuthenticatedUser: [
      "GET /user/packages/{package_type}/{package_name}/versions",
      {},
      {
        renamed: [
          "packages",
          "getAllPackageVersionsForPackageOwnedByAuthenticatedUser"
        ]
      }
    ],
    getAllPackageVersionsForPackageOwnedByAuthenticatedUser: [
      "GET /user/packages/{package_type}/{package_name}/versions"
    ],
    getAllPackageVersionsForPackageOwnedByOrg: [
      "GET /orgs/{org}/packages/{package_type}/{package_name}/versions"
    ],
    getAllPackageVersionsForPackageOwnedByUser: [
      "GET /users/{username}/packages/{package_type}/{package_name}/versions"
    ],
    getPackageForAuthenticatedUser: [
      "GET /user/packages/{package_type}/{package_name}"
    ],
    getPackageForOrganization: [
      "GET /orgs/{org}/packages/{package_type}/{package_name}"
    ],
    getPackageForUser: [
      "GET /users/{username}/packages/{package_type}/{package_name}"
    ],
    getPackageVersionForAuthenticatedUser: [
      "GET /user/packages/{package_type}/{package_name}/versions/{package_version_id}"
    ],
    getPackageVersionForOrganization: [
      "GET /orgs/{org}/packages/{package_type}/{package_name}/versions/{package_version_id}"
    ],
    getPackageVersionForUser: [
      "GET /users/{username}/packages/{package_type}/{package_name}/versions/{package_version_id}"
    ],
    listDockerMigrationConflictingPackagesForAuthenticatedUser: [
      "GET /user/docker/conflicts"
    ],
    listDockerMigrationConflictingPackagesForOrganization: [
      "GET /orgs/{org}/docker/conflicts"
    ],
    listDockerMigrationConflictingPackagesForUser: [
      "GET /users/{username}/docker/conflicts"
    ],
    listPackagesForAuthenticatedUser: ["GET /user/packages"],
    listPackagesForOrganization: ["GET /orgs/{org}/packages"],
    listPackagesForUser: ["GET /users/{username}/packages"],
    restorePackageForAuthenticatedUser: [
      "POST /user/packages/{package_type}/{package_name}/restore{?token}"
    ],
    restorePackageForOrg: [
      "POST /orgs/{org}/packages/{package_type}/{package_name}/restore{?token}"
    ],
    restorePackageForUser: [
      "POST /users/{username}/packages/{package_type}/{package_name}/restore{?token}"
    ],
    restorePackageVersionForAuthenticatedUser: [
      "POST /user/packages/{package_type}/{package_name}/versions/{package_version_id}/restore"
    ],
    restorePackageVersionForOrg: [
      "POST /orgs/{org}/packages/{package_type}/{package_name}/versions/{package_version_id}/restore"
    ],
    restorePackageVersionForUser: [
      "POST /users/{username}/packages/{package_type}/{package_name}/versions/{package_version_id}/restore"
    ]
  },
  privateRegistries: {
    createOrgPrivateRegistry: ["POST /orgs/{org}/private-registries"],
    deleteOrgPrivateRegistry: [
      "DELETE /orgs/{org}/private-registries/{secret_name}"
    ],
    getOrgPrivateRegistry: ["GET /orgs/{org}/private-registries/{secret_name}"],
    getOrgPublicKey: ["GET /orgs/{org}/private-registries/public-key"],
    listOrgPrivateRegistries: ["GET /orgs/{org}/private-registries"],
    updateOrgPrivateRegistry: [
      "PATCH /orgs/{org}/private-registries/{secret_name}"
    ]
  },
  projects: {
    addItemForOrg: ["POST /orgs/{org}/projectsV2/{project_number}/items"],
    addItemForUser: [
      "POST /users/{username}/projectsV2/{project_number}/items"
    ],
    deleteItemForOrg: [
      "DELETE /orgs/{org}/projectsV2/{project_number}/items/{item_id}"
    ],
    deleteItemForUser: [
      "DELETE /users/{username}/projectsV2/{project_number}/items/{item_id}"
    ],
    getFieldForOrg: [
      "GET /orgs/{org}/projectsV2/{project_number}/fields/{field_id}"
    ],
    getFieldForUser: [
      "GET /users/{username}/projectsV2/{project_number}/fields/{field_id}"
    ],
    getForOrg: ["GET /orgs/{org}/projectsV2/{project_number}"],
    getForUser: ["GET /users/{username}/projectsV2/{project_number}"],
    getOrgItem: ["GET /orgs/{org}/projectsV2/{project_number}/items/{item_id}"],
    getUserItem: [
      "GET /users/{username}/projectsV2/{project_number}/items/{item_id}"
    ],
    listFieldsForOrg: ["GET /orgs/{org}/projectsV2/{project_number}/fields"],
    listFieldsForUser: [
      "GET /users/{username}/projectsV2/{project_number}/fields"
    ],
    listForOrg: ["GET /orgs/{org}/projectsV2"],
    listForUser: ["GET /users/{username}/projectsV2"],
    listItemsForOrg: ["GET /orgs/{org}/projectsV2/{project_number}/items"],
    listItemsForUser: [
      "GET /users/{username}/projectsV2/{project_number}/items"
    ],
    updateItemForOrg: [
      "PATCH /orgs/{org}/projectsV2/{project_number}/items/{item_id}"
    ],
    updateItemForUser: [
      "PATCH /users/{username}/projectsV2/{project_number}/items/{item_id}"
    ]
  },
  pulls: {
    checkIfMerged: ["GET /repos/{owner}/{repo}/pulls/{pull_number}/merge"],
    create: ["POST /repos/{owner}/{repo}/pulls"],
    createReplyForReviewComment: [
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies"
    ],
    createReview: ["POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews"],
    createReviewComment: [
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/comments"
    ],
    deletePendingReview: [
      "DELETE /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}"
    ],
    deleteReviewComment: [
      "DELETE /repos/{owner}/{repo}/pulls/comments/{comment_id}"
    ],
    dismissReview: [
      "PUT /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/dismissals"
    ],
    get: ["GET /repos/{owner}/{repo}/pulls/{pull_number}"],
    getReview: [
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}"
    ],
    getReviewComment: ["GET /repos/{owner}/{repo}/pulls/comments/{comment_id}"],
    list: ["GET /repos/{owner}/{repo}/pulls"],
    listCommentsForReview: [
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments"
    ],
    listCommits: ["GET /repos/{owner}/{repo}/pulls/{pull_number}/commits"],
    listFiles: ["GET /repos/{owner}/{repo}/pulls/{pull_number}/files"],
    listRequestedReviewers: [
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers"
    ],
    listReviewComments: [
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments"
    ],
    listReviewCommentsForRepo: ["GET /repos/{owner}/{repo}/pulls/comments"],
    listReviews: ["GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews"],
    merge: ["PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge"],
    removeRequestedReviewers: [
      "DELETE /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers"
    ],
    requestReviewers: [
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers"
    ],
    submitReview: [
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/events"
    ],
    update: ["PATCH /repos/{owner}/{repo}/pulls/{pull_number}"],
    updateBranch: [
      "PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch"
    ],
    updateReview: [
      "PUT /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}"
    ],
    updateReviewComment: [
      "PATCH /repos/{owner}/{repo}/pulls/comments/{comment_id}"
    ]
  },
  rateLimit: { get: ["GET /rate_limit"] },
  reactions: {
    createForCommitComment: [
      "POST /repos/{owner}/{repo}/comments/{comment_id}/reactions"
    ],
    createForIssue: [
      "POST /repos/{owner}/{repo}/issues/{issue_number}/reactions"
    ],
    createForIssueComment: [
      "POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions"
    ],
    createForPullRequestReviewComment: [
      "POST /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions"
    ],
    createForRelease: [
      "POST /repos/{owner}/{repo}/releases/{release_id}/reactions"
    ],
    createForTeamDiscussionCommentInOrg: [
      "POST /orgs/{org}/teams/{team_slug}/discussions/{discussion_number}/comments/{comment_number}/reactions"
    ],
    createForTeamDiscussionInOrg: [
      "POST /orgs/{org}/teams/{team_slug}/discussions/{discussion_number}/reactions"
    ],
    deleteForCommitComment: [
      "DELETE /repos/{owner}/{repo}/comments/{comment_id}/reactions/{reaction_id}"
    ],
    deleteForIssue: [
      "DELETE /repos/{owner}/{repo}/issues/{issue_number}/reactions/{reaction_id}"
    ],
    deleteForIssueComment: [
      "DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions/{reaction_id}"
    ],
    deleteForPullRequestComment: [
      "DELETE /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions/{reaction_id}"
    ],
    deleteForRelease: [
      "DELETE /repos/{owner}/{repo}/releases/{release_id}/reactions/{reaction_id}"
    ],
    deleteForTeamDiscussion: [
      "DELETE /orgs/{org}/teams/{team_slug}/discussions/{discussion_number}/reactions/{reaction_id}"
    ],
    deleteForTeamDiscussionComment: [
      "DELETE /orgs/{org}/teams/{team_slug}/discussions/{discussion_number}/comments/{comment_number}/reactions/{reaction_id}"
    ],
    listForCommitComment: [
      "GET /repos/{owner}/{repo}/comments/{comment_id}/reactions"
    ],
    listForIssue: ["GET /repos/{owner}/{repo}/issues/{issue_number}/reactions"],
    listForIssueComment: [
      "GET /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions"
    ],
    listForPullRequestReviewComment: [
      "GET /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions"
    ],
    listForRelease: [
      "GET /repos/{owner}/{repo}/releases/{release_id}/reactions"
    ],
    listForTeamDiscussionCommentInOrg: [
      "GET /orgs/{org}/teams/{team_slug}/discussions/{discussion_number}/comments/{comment_number}/reactions"
    ],
    listForTeamDiscussionInOrg: [
      "GET /orgs/{org}/teams/{team_slug}/discussions/{discussion_number}/reactions"
    ]
  },
  repos: {
    acceptInvitation: [
      "PATCH /user/repository_invitations/{invitation_id}",
      {},
      { renamed: ["repos", "acceptInvitationForAuthenticatedUser"] }
    ],
    acceptInvitationForAuthenticatedUser: [
      "PATCH /user/repository_invitations/{invitation_id}"
    ],
    addAppAccessRestrictions: [
      "POST /repos/{owner}/{repo}/branches/{branch}/protection/restrictions/apps",
      {},
      { mapToData: "apps" }
    ],
    addCollaborator: ["PUT /repos/{owner}/{repo}/collaborators/{username}"],
    addStatusCheckContexts: [
      "POST /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks/contexts",
      {},
      { mapToData: "contexts" }
    ],
    addTeamAccessRestrictions: [
      "POST /repos/{owner}/{repo}/branches/{branch}/protection/restrictions/teams",
      {},
      { mapToData: "teams" }
    ],
    addUserAccessRestrictions: [
      "POST /repos/{owner}/{repo}/branches/{branch}/protection/restrictions/users",
      {},
      { mapToData: "users" }
    ],
    cancelPagesDeployment: [
      "POST /repos/{owner}/{repo}/pages/deployments/{pages_deployment_id}/cancel"
    ],
    checkAutomatedSecurityFixes: [
      "GET /repos/{owner}/{repo}/automated-security-fixes"
    ],
    checkCollaborator: ["GET /repos/{owner}/{repo}/collaborators/{username}"],
    checkImmutableReleases: ["GET /repos/{owner}/{repo}/immutable-releases"],
    checkPrivateVulnerabilityReporting: [
      "GET /repos/{owner}/{repo}/private-vulnerability-reporting"
    ],
    checkVulnerabilityAlerts: [
      "GET /repos/{owner}/{repo}/vulnerability-alerts"
    ],
    codeownersErrors: ["GET /repos/{owner}/{repo}/codeowners/errors"],
    compareCommits: ["GET /repos/{owner}/{repo}/compare/{base}...{head}"],
    compareCommitsWithBasehead: [
      "GET /repos/{owner}/{repo}/compare/{basehead}"
    ],
    createAttestation: ["POST /repos/{owner}/{repo}/attestations"],
    createAutolink: ["POST /repos/{owner}/{repo}/autolinks"],
    createCommitComment: [
      "POST /repos/{owner}/{repo}/commits/{commit_sha}/comments"
    ],
    createCommitSignatureProtection: [
      "POST /repos/{owner}/{repo}/branches/{branch}/protection/required_signatures"
    ],
    createCommitStatus: ["POST /repos/{owner}/{repo}/statuses/{sha}"],
    createDeployKey: ["POST /repos/{owner}/{repo}/keys"],
    createDeployment: ["POST /repos/{owner}/{repo}/deployments"],
    createDeploymentBranchPolicy: [
      "POST /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies"
    ],
    createDeploymentProtectionRule: [
      "POST /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules"
    ],
    createDeploymentStatus: [
      "POST /repos/{owner}/{repo}/deployments/{deployment_id}/statuses"
    ],
    createDispatchEvent: ["POST /repos/{owner}/{repo}/dispatches"],
    createForAuthenticatedUser: ["POST /user/repos"],
    createFork: ["POST /repos/{owner}/{repo}/forks"],
    createInOrg: ["POST /orgs/{org}/repos"],
    createOrUpdateEnvironment: [
      "PUT /repos/{owner}/{repo}/environments/{environment_name}"
    ],
    createOrUpdateFileContents: ["PUT /repos/{owner}/{repo}/contents/{path}"],
    createOrgRuleset: ["POST /orgs/{org}/rulesets"],
    createPagesDeployment: ["POST /repos/{owner}/{repo}/pages/deployments"],
    createPagesSite: ["POST /repos/{owner}/{repo}/pages"],
    createRelease: ["POST /repos/{owner}/{repo}/releases"],
    createRepoRuleset: ["POST /repos/{owner}/{repo}/rulesets"],
    createUsingTemplate: [
      "POST /repos/{template_owner}/{template_repo}/generate"
    ],
    createWebhook: ["POST /repos/{owner}/{repo}/hooks"],
    customPropertiesForReposCreateOrUpdateRepositoryValues: [
      "PATCH /repos/{owner}/{repo}/properties/values"
    ],
    customPropertiesForReposGetRepositoryValues: [
      "GET /repos/{owner}/{repo}/properties/values"
    ],
    declineInvitation: [
      "DELETE /user/repository_invitations/{invitation_id}",
      {},
      { renamed: ["repos", "declineInvitationForAuthenticatedUser"] }
    ],
    declineInvitationForAuthenticatedUser: [
      "DELETE /user/repository_invitations/{invitation_id}"
    ],
    delete: ["DELETE /repos/{owner}/{repo}"],
    deleteAccessRestrictions: [
      "DELETE /repos/{owner}/{repo}/branches/{branch}/protection/restrictions"
    ],
    deleteAdminBranchProtection: [
      "DELETE /repos/{owner}/{repo}/branches/{branch}/protection/enforce_admins"
    ],
    deleteAnEnvironment: [
      "DELETE /repos/{owner}/{repo}/environments/{environment_name}"
    ],
    deleteAutolink: ["DELETE /repos/{owner}/{repo}/autolinks/{autolink_id}"],
    deleteBranchProtection: [
      "DELETE /repos/{owner}/{repo}/branches/{branch}/protection"
    ],
    deleteCommitComment: ["DELETE /repos/{owner}/{repo}/comments/{comment_id}"],
    deleteCommitSignatureProtection: [
      "DELETE /repos/{owner}/{repo}/branches/{branch}/protection/required_signatures"
    ],
    deleteDeployKey: ["DELETE /repos/{owner}/{repo}/keys/{key_id}"],
    deleteDeployment: [
      "DELETE /repos/{owner}/{repo}/deployments/{deployment_id}"
    ],
    deleteDeploymentBranchPolicy: [
      "DELETE /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies/{branch_policy_id}"
    ],
    deleteFile: ["DELETE /repos/{owner}/{repo}/contents/{path}"],
    deleteInvitation: [
      "DELETE /repos/{owner}/{repo}/invitations/{invitation_id}"
    ],
    deleteOrgRuleset: ["DELETE /orgs/{org}/rulesets/{ruleset_id}"],
    deletePagesSite: ["DELETE /repos/{owner}/{repo}/pages"],
    deletePullRequestReviewProtection: [
      "DELETE /repos/{owner}/{repo}/branches/{branch}/protection/required_pull_request_reviews"
    ],
    deleteRelease: ["DELETE /repos/{owner}/{repo}/releases/{release_id}"],
    deleteReleaseAsset: [
      "DELETE /repos/{owner}/{repo}/releases/assets/{asset_id}"
    ],
    deleteRepoRuleset: ["DELETE /repos/{owner}/{repo}/rulesets/{ruleset_id}"],
    deleteWebhook: ["DELETE /repos/{owner}/{repo}/hooks/{hook_id}"],
    disableAutomatedSecurityFixes: [
      "DELETE /repos/{owner}/{repo}/automated-security-fixes"
    ],
    disableDeploymentProtectionRule: [
      "DELETE /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules/{protection_rule_id}"
    ],
    disableImmutableReleases: [
      "DELETE /repos/{owner}/{repo}/immutable-releases"
    ],
    disablePrivateVulnerabilityReporting: [
      "DELETE /repos/{owner}/{repo}/private-vulnerability-reporting"
    ],
    disableVulnerabilityAlerts: [
      "DELETE /repos/{owner}/{repo}/vulnerability-alerts"
    ],
    downloadArchive: [
      "GET /repos/{owner}/{repo}/zipball/{ref}",
      {},
      { renamed: ["repos", "downloadZipballArchive"] }
    ],
    downloadTarballArchive: ["GET /repos/{owner}/{repo}/tarball/{ref}"],
    downloadZipballArchive: ["GET /repos/{owner}/{repo}/zipball/{ref}"],
    enableAutomatedSecurityFixes: [
      "PUT /repos/{owner}/{repo}/automated-security-fixes"
    ],
    enableImmutableReleases: ["PUT /repos/{owner}/{repo}/immutable-releases"],
    enablePrivateVulnerabilityReporting: [
      "PUT /repos/{owner}/{repo}/private-vulnerability-reporting"
    ],
    enableVulnerabilityAlerts: [
      "PUT /repos/{owner}/{repo}/vulnerability-alerts"
    ],
    generateReleaseNotes: [
      "POST /repos/{owner}/{repo}/releases/generate-notes"
    ],
    get: ["GET /repos/{owner}/{repo}"],
    getAccessRestrictions: [
      "GET /repos/{owner}/{repo}/branches/{branch}/protection/restrictions"
    ],
    getAdminBranchProtection: [
      "GET /repos/{owner}/{repo}/branches/{branch}/protection/enforce_admins"
    ],
    getAllDeploymentProtectionRules: [
      "GET /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules"
    ],
    getAllEnvironments: ["GET /repos/{owner}/{repo}/environments"],
    getAllStatusCheckContexts: [
      "GET /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks/contexts"
    ],
    getAllTopics: ["GET /repos/{owner}/{repo}/topics"],
    getAppsWithAccessToProtectedBranch: [
      "GET /repos/{owner}/{repo}/branches/{branch}/protection/restrictions/apps"
    ],
    getAutolink: ["GET /repos/{owner}/{repo}/autolinks/{autolink_id}"],
    getBranch: ["GET /repos/{owner}/{repo}/branches/{branch}"],
    getBranchProtection: [
      "GET /repos/{owner}/{repo}/branches/{branch}/protection"
    ],
    getBranchRules: ["GET /repos/{owner}/{repo}/rules/branches/{branch}"],
    getClones: ["GET /repos/{owner}/{repo}/traffic/clones"],
    getCodeFrequencyStats: ["GET /repos/{owner}/{repo}/stats/code_frequency"],
    getCollaboratorPermissionLevel: [
      "GET /repos/{owner}/{repo}/collaborators/{username}/permission"
    ],
    getCombinedStatusForRef: ["GET /repos/{owner}/{repo}/commits/{ref}/status"],
    getCommit: ["GET /repos/{owner}/{repo}/commits/{ref}"],
    getCommitActivityStats: ["GET /repos/{owner}/{repo}/stats/commit_activity"],
    getCommitComment: ["GET /repos/{owner}/{repo}/comments/{comment_id}"],
    getCommitSignatureProtection: [
      "GET /repos/{owner}/{repo}/branches/{branch}/protection/required_signatures"
    ],
    getCommunityProfileMetrics: ["GET /repos/{owner}/{repo}/community/profile"],
    getContent: ["GET /repos/{owner}/{repo}/contents/{path}"],
    getContributorsStats: ["GET /repos/{owner}/{repo}/stats/contributors"],
    getCustomDeploymentProtectionRule: [
      "GET /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules/{protection_rule_id}"
    ],
    getDeployKey: ["GET /repos/{owner}/{repo}/keys/{key_id}"],
    getDeployment: ["GET /repos/{owner}/{repo}/deployments/{deployment_id}"],
    getDeploymentBranchPolicy: [
      "GET /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies/{branch_policy_id}"
    ],
    getDeploymentStatus: [
      "GET /repos/{owner}/{repo}/deployments/{deployment_id}/statuses/{status_id}"
    ],
    getEnvironment: [
      "GET /repos/{owner}/{repo}/environments/{environment_name}"
    ],
    getLatestPagesBuild: ["GET /repos/{owner}/{repo}/pages/builds/latest"],
    getLatestRelease: ["GET /repos/{owner}/{repo}/releases/latest"],
    getOrgRuleSuite: ["GET /orgs/{org}/rulesets/rule-suites/{rule_suite_id}"],
    getOrgRuleSuites: ["GET /orgs/{org}/rulesets/rule-suites"],
    getOrgRuleset: ["GET /orgs/{org}/rulesets/{ruleset_id}"],
    getOrgRulesets: ["GET /orgs/{org}/rulesets"],
    getPages: ["GET /repos/{owner}/{repo}/pages"],
    getPagesBuild: ["GET /repos/{owner}/{repo}/pages/builds/{build_id}"],
    getPagesDeployment: [
      "GET /repos/{owner}/{repo}/pages/deployments/{pages_deployment_id}"
    ],
    getPagesHealthCheck: ["GET /repos/{owner}/{repo}/pages/health"],
    getParticipationStats: ["GET /repos/{owner}/{repo}/stats/participation"],
    getPullRequestReviewProtection: [
      "GET /repos/{owner}/{repo}/branches/{branch}/protection/required_pull_request_reviews"
    ],
    getPunchCardStats: ["GET /repos/{owner}/{repo}/stats/punch_card"],
    getReadme: ["GET /repos/{owner}/{repo}/readme"],
    getReadmeInDirectory: ["GET /repos/{owner}/{repo}/readme/{dir}"],
    getRelease: ["GET /repos/{owner}/{repo}/releases/{release_id}"],
    getReleaseAsset: ["GET /repos/{owner}/{repo}/releases/assets/{asset_id}"],
    getReleaseByTag: ["GET /repos/{owner}/{repo}/releases/tags/{tag}"],
    getRepoRuleSuite: [
      "GET /repos/{owner}/{repo}/rulesets/rule-suites/{rule_suite_id}"
    ],
    getRepoRuleSuites: ["GET /repos/{owner}/{repo}/rulesets/rule-suites"],
    getRepoRuleset: ["GET /repos/{owner}/{repo}/rulesets/{ruleset_id}"],
    getRepoRulesetHistory: [
      "GET /repos/{owner}/{repo}/rulesets/{ruleset_id}/history"
    ],
    getRepoRulesetVersion: [
      "GET /repos/{owner}/{repo}/rulesets/{ruleset_id}/history/{version_id}"
    ],
    getRepoRulesets: ["GET /repos/{owner}/{repo}/rulesets"],
    getStatusChecksProtection: [
      "GET /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks"
    ],
    getTeamsWithAccessToProtectedBranch: [
      "GET /repos/{owner}/{repo}/branches/{branch}/protection/restrictions/teams"
    ],
    getTopPaths: ["GET /repos/{owner}/{repo}/traffic/popular/paths"],
    getTopReferrers: ["GET /repos/{owner}/{repo}/traffic/popular/referrers"],
    getUsersWithAccessToProtectedBranch: [
      "GET /repos/{owner}/{repo}/branches/{branch}/protection/restrictions/users"
    ],
    getViews: ["GET /repos/{owner}/{repo}/traffic/views"],
    getWebhook: ["GET /repos/{owner}/{repo}/hooks/{hook_id}"],
    getWebhookConfigForRepo: [
      "GET /repos/{owner}/{repo}/hooks/{hook_id}/config"
    ],
    getWebhookDelivery: [
      "GET /repos/{owner}/{repo}/hooks/{hook_id}/deliveries/{delivery_id}"
    ],
    listActivities: ["GET /repos/{owner}/{repo}/activity"],
    listAttestations: [
      "GET /repos/{owner}/{repo}/attestations/{subject_digest}"
    ],
    listAutolinks: ["GET /repos/{owner}/{repo}/autolinks"],
    listBranches: ["GET /repos/{owner}/{repo}/branches"],
    listBranchesForHeadCommit: [
      "GET /repos/{owner}/{repo}/commits/{commit_sha}/branches-where-head"
    ],
    listCollaborators: ["GET /repos/{owner}/{repo}/collaborators"],
    listCommentsForCommit: [
      "GET /repos/{owner}/{repo}/commits/{commit_sha}/comments"
    ],
    listCommitCommentsForRepo: ["GET /repos/{owner}/{repo}/comments"],
    listCommitStatusesForRef: [
      "GET /repos/{owner}/{repo}/commits/{ref}/statuses"
    ],
    listCommits: ["GET /repos/{owner}/{repo}/commits"],
    listContributors: ["GET /repos/{owner}/{repo}/contributors"],
    listCustomDeploymentRuleIntegrations: [
      "GET /repos/{owner}/{repo}/environments/{environment_name}/deployment_protection_rules/apps"
    ],
    listDeployKeys: ["GET /repos/{owner}/{repo}/keys"],
    listDeploymentBranchPolicies: [
      "GET /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies"
    ],
    listDeploymentStatuses: [
      "GET /repos/{owner}/{repo}/deployments/{deployment_id}/statuses"
    ],
    listDeployments: ["GET /repos/{owner}/{repo}/deployments"],
    listForAuthenticatedUser: ["GET /user/repos"],
    listForOrg: ["GET /orgs/{org}/repos"],
    listForUser: ["GET /users/{username}/repos"],
    listForks: ["GET /repos/{owner}/{repo}/forks"],
    listInvitations: ["GET /repos/{owner}/{repo}/invitations"],
    listInvitationsForAuthenticatedUser: ["GET /user/repository_invitations"],
    listLanguages: ["GET /repos/{owner}/{repo}/languages"],
    listPagesBuilds: ["GET /repos/{owner}/{repo}/pages/builds"],
    listPublic: ["GET /repositories"],
    listPullRequestsAssociatedWithCommit: [
      "GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls"
    ],
    listReleaseAssets: [
      "GET /repos/{owner}/{repo}/releases/{release_id}/assets"
    ],
    listReleases: ["GET /repos/{owner}/{repo}/releases"],
    listTags: ["GET /repos/{owner}/{repo}/tags"],
    listTeams: ["GET /repos/{owner}/{repo}/teams"],
    listWebhookDeliveries: [
      "GET /repos/{owner}/{repo}/hooks/{hook_id}/deliveries"
    ],
    listWebhooks: ["GET /repos/{owner}/{repo}/hooks"],
    merge: ["POST /repos/{owner}/{repo}/merges"],
    mergeUpstream: ["POST /repos/{owner}/{repo}/merge-upstream"],
    pingWebhook: ["POST /repos/{owner}/{repo}/hooks/{hook_id}/pings"],
    redeliverWebhookDelivery: [
      "POST /repos/{owner}/{repo}/hooks/{hook_id}/deliveries/{delivery_id}/attempts"
    ],
    removeAppAccessRestrictions: [
      "DELETE /repos/{owner}/{repo}/branches/{branch}/protection/restrictions/apps",
      {},
      { mapToData: "apps" }
    ],
    removeCollaborator: [
      "DELETE /repos/{owner}/{repo}/collaborators/{username}"
    ],
    removeStatusCheckContexts: [
      "DELETE /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks/contexts",
      {},
      { mapToData: "contexts" }
    ],
    removeStatusCheckProtection: [
      "DELETE /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks"
    ],
    removeTeamAccessRestrictions: [
      "DELETE /repos/{owner}/{repo}/branches/{branch}/protection/restrictions/teams",
      {},
      { mapToData: "teams" }
    ],
    removeUserAccessRestrictions: [
      "DELETE /repos/{owner}/{repo}/branches/{branch}/protection/restrictions/users",
      {},
      { mapToData: "users" }
    ],
    renameBranch: ["POST /repos/{owner}/{repo}/branches/{branch}/rename"],
    replaceAllTopics: ["PUT /repos/{owner}/{repo}/topics"],
    requestPagesBuild: ["POST /repos/{owner}/{repo}/pages/builds"],
    setAdminBranchProtection: [
      "POST /repos/{owner}/{repo}/branches/{branch}/protection/enforce_admins"
    ],
    setAppAccessRestrictions: [
      "PUT /repos/{owner}/{repo}/branches/{branch}/protection/restrictions/apps",
      {},
      { mapToData: "apps" }
    ],
    setStatusCheckContexts: [
      "PUT /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks/contexts",
      {},
      { mapToData: "contexts" }
    ],
    setTeamAccessRestrictions: [
      "PUT /repos/{owner}/{repo}/branches/{branch}/protection/restrictions/teams",
      {},
      { mapToData: "teams" }
    ],
    setUserAccessRestrictions: [
      "PUT /repos/{owner}/{repo}/branches/{branch}/protection/restrictions/users",
      {},
      { mapToData: "users" }
    ],
    testPushWebhook: ["POST /repos/{owner}/{repo}/hooks/{hook_id}/tests"],
    transfer: ["POST /repos/{owner}/{repo}/transfer"],
    update: ["PATCH /repos/{owner}/{repo}"],
    updateBranchProtection: [
      "PUT /repos/{owner}/{repo}/branches/{branch}/protection"
    ],
    updateCommitComment: ["PATCH /repos/{owner}/{repo}/comments/{comment_id}"],
    updateDeploymentBranchPolicy: [
      "PUT /repos/{owner}/{repo}/environments/{environment_name}/deployment-branch-policies/{branch_policy_id}"
    ],
    updateInformationAboutPagesSite: ["PUT /repos/{owner}/{repo}/pages"],
    updateInvitation: [
      "PATCH /repos/{owner}/{repo}/invitations/{invitation_id}"
    ],
    updateOrgRuleset: ["PUT /orgs/{org}/rulesets/{ruleset_id}"],
    updatePullRequestReviewProtection: [
      "PATCH /repos/{owner}/{repo}/branches/{branch}/protection/required_pull_request_reviews"
    ],
    updateRelease: ["PATCH /repos/{owner}/{repo}/releases/{release_id}"],
    updateReleaseAsset: [
      "PATCH /repos/{owner}/{repo}/releases/assets/{asset_id}"
    ],
    updateRepoRuleset: ["PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}"],
    updateStatusCheckPotection: [
      "PATCH /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks",
      {},
      { renamed: ["repos", "updateStatusCheckProtection"] }
    ],
    updateStatusCheckProtection: [
      "PATCH /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks"
    ],
    updateWebhook: ["PATCH /repos/{owner}/{repo}/hooks/{hook_id}"],
    updateWebhookConfigForRepo: [
      "PATCH /repos/{owner}/{repo}/hooks/{hook_id}/config"
    ],
    uploadReleaseAsset: [
      "POST /repos/{owner}/{repo}/releases/{release_id}/assets{?name,label}",
      { baseUrl: "https://uploads.github.com" }
    ]
  },
  search: {
    code: ["GET /search/code"],
    commits: ["GET /search/commits"],
    issuesAndPullRequests: ["GET /search/issues"],
    labels: ["GET /search/labels"],
    repos: ["GET /search/repositories"],
    topics: ["GET /search/topics"],
    users: ["GET /search/users"]
  },
  secretScanning: {
    createPushProtectionBypass: [
      "POST /repos/{owner}/{repo}/secret-scanning/push-protection-bypasses"
    ],
    getAlert: [
      "GET /repos/{owner}/{repo}/secret-scanning/alerts/{alert_number}"
    ],
    getScanHistory: ["GET /repos/{owner}/{repo}/secret-scanning/scan-history"],
    listAlertsForOrg: ["GET /orgs/{org}/secret-scanning/alerts"],
    listAlertsForRepo: ["GET /repos/{owner}/{repo}/secret-scanning/alerts"],
    listLocationsForAlert: [
      "GET /repos/{owner}/{repo}/secret-scanning/alerts/{alert_number}/locations"
    ],
    listOrgPatternConfigs: [
      "GET /orgs/{org}/secret-scanning/pattern-configurations"
    ],
    updateAlert: [
      "PATCH /repos/{owner}/{repo}/secret-scanning/alerts/{alert_number}"
    ],
    updateOrgPatternConfigs: [
      "PATCH /orgs/{org}/secret-scanning/pattern-configurations"
    ]
  },
  securityAdvisories: {
    createFork: [
      "POST /repos/{owner}/{repo}/security-advisories/{ghsa_id}/forks"
    ],
    createPrivateVulnerabilityReport: [
      "POST /repos/{owner}/{repo}/security-advisories/reports"
    ],
    createRepositoryAdvisory: [
      "POST /repos/{owner}/{repo}/security-advisories"
    ],
    createRepositoryAdvisoryCveRequest: [
      "POST /repos/{owner}/{repo}/security-advisories/{ghsa_id}/cve"
    ],
    getGlobalAdvisory: ["GET /advisories/{ghsa_id}"],
    getRepositoryAdvisory: [
      "GET /repos/{owner}/{repo}/security-advisories/{ghsa_id}"
    ],
    listGlobalAdvisories: ["GET /advisories"],
    listOrgRepositoryAdvisories: ["GET /orgs/{org}/security-advisories"],
    listRepositoryAdvisories: ["GET /repos/{owner}/{repo}/security-advisories"],
    updateRepositoryAdvisory: [
      "PATCH /repos/{owner}/{repo}/security-advisories/{ghsa_id}"
    ]
  },
  teams: {
    addOrUpdateMembershipForUserInOrg: [
      "PUT /orgs/{org}/teams/{team_slug}/memberships/{username}"
    ],
    addOrUpdateRepoPermissionsInOrg: [
      "PUT /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}"
    ],
    checkPermissionsForRepoInOrg: [
      "GET /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}"
    ],
    create: ["POST /orgs/{org}/teams"],
    createDiscussionCommentInOrg: [
      "POST /orgs/{org}/teams/{team_slug}/discussions/{discussion_number}/comments"
    ],
    createDiscussionInOrg: ["POST /orgs/{org}/teams/{team_slug}/discussions"],
    deleteDiscussionCommentInOrg: [
      "DELETE /orgs/{org}/teams/{team_slug}/discussions/{discussion_number}/comments/{comment_number}"
    ],
    deleteDiscussionInOrg: [
      "DELETE /orgs/{org}/teams/{team_slug}/discussions/{discussion_number}"
    ],
    deleteInOrg: ["DELETE /orgs/{org}/teams/{team_slug}"],
    getByName: ["GET /orgs/{org}/teams/{team_slug}"],
    getDiscussionCommentInOrg: [
      "GET /orgs/{org}/teams/{team_slug}/discussions/{discussion_number}/comments/{comment_number}"
    ],
    getDiscussionInOrg: [
      "GET /orgs/{org}/teams/{team_slug}/discussions/{discussion_number}"
    ],
    getMembershipForUserInOrg: [
      "GET /orgs/{org}/teams/{team_slug}/memberships/{username}"
    ],
    list: ["GET /orgs/{org}/teams"],
    listChildInOrg: ["GET /orgs/{org}/teams/{team_slug}/teams"],
    listDiscussionCommentsInOrg: [
      "GET /orgs/{org}/teams/{team_slug}/discussions/{discussion_number}/comments"
    ],
    listDiscussionsInOrg: ["GET /orgs/{org}/teams/{team_slug}/discussions"],
    listForAuthenticatedUser: ["GET /user/teams"],
    listMembersInOrg: ["GET /orgs/{org}/teams/{team_slug}/members"],
    listPendingInvitationsInOrg: [
      "GET /orgs/{org}/teams/{team_slug}/invitations"
    ],
    listReposInOrg: ["GET /orgs/{org}/teams/{team_slug}/repos"],
    removeMembershipForUserInOrg: [
      "DELETE /orgs/{org}/teams/{team_slug}/memberships/{username}"
    ],
    removeRepoInOrg: [
      "DELETE /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}"
    ],
    updateDiscussionCommentInOrg: [
      "PATCH /orgs/{org}/teams/{team_slug}/discussions/{discussion_number}/comments/{comment_number}"
    ],
    updateDiscussionInOrg: [
      "PATCH /orgs/{org}/teams/{team_slug}/discussions/{discussion_number}"
    ],
    updateInOrg: ["PATCH /orgs/{org}/teams/{team_slug}"]
  },
  users: {
    addEmailForAuthenticated: [
      "POST /user/emails",
      {},
      { renamed: ["users", "addEmailForAuthenticatedUser"] }
    ],
    addEmailForAuthenticatedUser: ["POST /user/emails"],
    addSocialAccountForAuthenticatedUser: ["POST /user/social_accounts"],
    block: ["PUT /user/blocks/{username}"],
    checkBlocked: ["GET /user/blocks/{username}"],
    checkFollowingForUser: ["GET /users/{username}/following/{target_user}"],
    checkPersonIsFollowedByAuthenticated: ["GET /user/following/{username}"],
    createGpgKeyForAuthenticated: [
      "POST /user/gpg_keys",
      {},
      { renamed: ["users", "createGpgKeyForAuthenticatedUser"] }
    ],
    createGpgKeyForAuthenticatedUser: ["POST /user/gpg_keys"],
    createPublicSshKeyForAuthenticated: [
      "POST /user/keys",
      {},
      { renamed: ["users", "createPublicSshKeyForAuthenticatedUser"] }
    ],
    createPublicSshKeyForAuthenticatedUser: ["POST /user/keys"],
    createSshSigningKeyForAuthenticatedUser: ["POST /user/ssh_signing_keys"],
    deleteAttestationsBulk: [
      "POST /users/{username}/attestations/delete-request"
    ],
    deleteAttestationsById: [
      "DELETE /users/{username}/attestations/{attestation_id}"
    ],
    deleteAttestationsBySubjectDigest: [
      "DELETE /users/{username}/attestations/digest/{subject_digest}"
    ],
    deleteEmailForAuthenticated: [
      "DELETE /user/emails",
      {},
      { renamed: ["users", "deleteEmailForAuthenticatedUser"] }
    ],
    deleteEmailForAuthenticatedUser: ["DELETE /user/emails"],
    deleteGpgKeyForAuthenticated: [
      "DELETE /user/gpg_keys/{gpg_key_id}",
      {},
      { renamed: ["users", "deleteGpgKeyForAuthenticatedUser"] }
    ],
    deleteGpgKeyForAuthenticatedUser: ["DELETE /user/gpg_keys/{gpg_key_id}"],
    deletePublicSshKeyForAuthenticated: [
      "DELETE /user/keys/{key_id}",
      {},
      { renamed: ["users", "deletePublicSshKeyForAuthenticatedUser"] }
    ],
    deletePublicSshKeyForAuthenticatedUser: ["DELETE /user/keys/{key_id}"],
    deleteSocialAccountForAuthenticatedUser: ["DELETE /user/social_accounts"],
    deleteSshSigningKeyForAuthenticatedUser: [
      "DELETE /user/ssh_signing_keys/{ssh_signing_key_id}"
    ],
    follow: ["PUT /user/following/{username}"],
    getAuthenticated: ["GET /user"],
    getById: ["GET /user/{account_id}"],
    getByUsername: ["GET /users/{username}"],
    getContextForUser: ["GET /users/{username}/hovercard"],
    getGpgKeyForAuthenticated: [
      "GET /user/gpg_keys/{gpg_key_id}",
      {},
      { renamed: ["users", "getGpgKeyForAuthenticatedUser"] }
    ],
    getGpgKeyForAuthenticatedUser: ["GET /user/gpg_keys/{gpg_key_id}"],
    getPublicSshKeyForAuthenticated: [
      "GET /user/keys/{key_id}",
      {},
      { renamed: ["users", "getPublicSshKeyForAuthenticatedUser"] }
    ],
    getPublicSshKeyForAuthenticatedUser: ["GET /user/keys/{key_id}"],
    getSshSigningKeyForAuthenticatedUser: [
      "GET /user/ssh_signing_keys/{ssh_signing_key_id}"
    ],
    list: ["GET /users"],
    listAttestations: ["GET /users/{username}/attestations/{subject_digest}"],
    listAttestationsBulk: [
      "POST /users/{username}/attestations/bulk-list{?per_page,before,after}"
    ],
    listBlockedByAuthenticated: [
      "GET /user/blocks",
      {},
      { renamed: ["users", "listBlockedByAuthenticatedUser"] }
    ],
    listBlockedByAuthenticatedUser: ["GET /user/blocks"],
    listEmailsForAuthenticated: [
      "GET /user/emails",
      {},
      { renamed: ["users", "listEmailsForAuthenticatedUser"] }
    ],
    listEmailsForAuthenticatedUser: ["GET /user/emails"],
    listFollowedByAuthenticated: [
      "GET /user/following",
      {},
      { renamed: ["users", "listFollowedByAuthenticatedUser"] }
    ],
    listFollowedByAuthenticatedUser: ["GET /user/following"],
    listFollowersForAuthenticatedUser: ["GET /user/followers"],
    listFollowersForUser: ["GET /users/{username}/followers"],
    listFollowingForUser: ["GET /users/{username}/following"],
    listGpgKeysForAuthenticated: [
      "GET /user/gpg_keys",
      {},
      { renamed: ["users", "listGpgKeysForAuthenticatedUser"] }
    ],
    listGpgKeysForAuthenticatedUser: ["GET /user/gpg_keys"],
    listGpgKeysForUser: ["GET /users/{username}/gpg_keys"],
    listPublicEmailsForAuthenticated: [
      "GET /user/public_emails",
      {},
      { renamed: ["users", "listPublicEmailsForAuthenticatedUser"] }
    ],
    listPublicEmailsForAuthenticatedUser: ["GET /user/public_emails"],
    listPublicKeysForUser: ["GET /users/{username}/keys"],
    listPublicSshKeysForAuthenticated: [
      "GET /user/keys",
      {},
      { renamed: ["users", "listPublicSshKeysForAuthenticatedUser"] }
    ],
    listPublicSshKeysForAuthenticatedUser: ["GET /user/keys"],
    listSocialAccountsForAuthenticatedUser: ["GET /user/social_accounts"],
    listSocialAccountsForUser: ["GET /users/{username}/social_accounts"],
    listSshSigningKeysForAuthenticatedUser: ["GET /user/ssh_signing_keys"],
    listSshSigningKeysForUser: ["GET /users/{username}/ssh_signing_keys"],
    setPrimaryEmailVisibilityForAuthenticated: [
      "PATCH /user/email/visibility",
      {},
      { renamed: ["users", "setPrimaryEmailVisibilityForAuthenticatedUser"] }
    ],
    setPrimaryEmailVisibilityForAuthenticatedUser: [
      "PATCH /user/email/visibility"
    ],
    unblock: ["DELETE /user/blocks/{username}"],
    unfollow: ["DELETE /user/following/{username}"],
    updateAuthenticated: ["PATCH /user"]
  }
};
var endpoints_default = Endpoints;

const endpointMethodsMap = /* @__PURE__ */ new Map();
for (const [scope, endpoints] of Object.entries(endpoints_default)) {
  for (const [methodName, endpoint] of Object.entries(endpoints)) {
    const [route, defaults, decorations] = endpoint;
    const [method, url] = route.split(/ /);
    const endpointDefaults = Object.assign(
      {
        method,
        url
      },
      defaults
    );
    if (!endpointMethodsMap.has(scope)) {
      endpointMethodsMap.set(scope, /* @__PURE__ */ new Map());
    }
    endpointMethodsMap.get(scope).set(methodName, {
      scope,
      methodName,
      endpointDefaults,
      decorations
    });
  }
}
const handler = {
  has({ scope }, methodName) {
    return endpointMethodsMap.get(scope).has(methodName);
  },
  getOwnPropertyDescriptor(target, methodName) {
    return {
      value: this.get(target, methodName),
      // ensures method is in the cache
      configurable: true,
      writable: true,
      enumerable: true
    };
  },
  defineProperty(target, methodName, descriptor) {
    Object.defineProperty(target.cache, methodName, descriptor);
    return true;
  },
  deleteProperty(target, methodName) {
    delete target.cache[methodName];
    return true;
  },
  ownKeys({ scope }) {
    return [...endpointMethodsMap.get(scope).keys()];
  },
  set(target, methodName, value) {
    return target.cache[methodName] = value;
  },
  get({ octokit, scope, cache }, methodName) {
    if (cache[methodName]) {
      return cache[methodName];
    }
    const method = endpointMethodsMap.get(scope).get(methodName);
    if (!method) {
      return void 0;
    }
    const { endpointDefaults, decorations } = method;
    if (decorations) {
      cache[methodName] = decorate(
        octokit,
        scope,
        methodName,
        endpointDefaults,
        decorations
      );
    } else {
      cache[methodName] = octokit.request.defaults(endpointDefaults);
    }
    return cache[methodName];
  }
};
function endpointsToMethods(octokit) {
  const newMethods = {};
  for (const scope of endpointMethodsMap.keys()) {
    newMethods[scope] = new Proxy({ octokit, scope, cache: {} }, handler);
  }
  return newMethods;
}
function decorate(octokit, scope, methodName, defaults, decorations) {
  const requestWithDefaults = octokit.request.defaults(defaults);
  function withDecorations(...args) {
    let options = requestWithDefaults.endpoint.merge(...args);
    if (decorations.mapToData) {
      options = Object.assign({}, options, {
        data: options[decorations.mapToData],
        [decorations.mapToData]: void 0
      });
      return requestWithDefaults(options);
    }
    if (decorations.renamed) {
      const [newScope, newMethodName] = decorations.renamed;
      octokit.log.warn(
        `octokit.${scope}.${methodName}() has been renamed to octokit.${newScope}.${newMethodName}()`
      );
    }
    if (decorations.deprecated) {
      octokit.log.warn(decorations.deprecated);
    }
    if (decorations.renamedParameters) {
      const options2 = requestWithDefaults.endpoint.merge(...args);
      for (const [name, alias] of Object.entries(
        decorations.renamedParameters
      )) {
        if (name in options2) {
          octokit.log.warn(
            `"${name}" parameter is deprecated for "octokit.${scope}.${methodName}()". Use "${alias}" instead`
          );
          if (!(alias in options2)) {
            options2[alias] = options2[name];
          }
          delete options2[name];
        }
      }
      return requestWithDefaults(options2);
    }
    return requestWithDefaults(...args);
  }
  return Object.assign(withDecorations, requestWithDefaults);
}

function legacyRestEndpointMethods(octokit) {
  const api = endpointsToMethods(octokit);
  return {
    ...api,
    rest: api
  };
}
legacyRestEndpointMethods.VERSION = VERSION$1;

const VERSION = "22.0.1";

const Octokit = Octokit$1.plugin(requestLog, legacyRestEndpointMethods, paginateRest).defaults(
  {
    userAgent: `octokit-rest.js/${VERSION}`
  }
);

/**
 * A GitHub read or write that did not give a usable result. `cause` keeps the original
 * error (for an Octokit `RequestError`: its `status` and response headers, so rate limits
 * stay identifiable). The message names only the operation and the HTTP status.
 */
class GitHubError extends Error {
    code;
    operation;
    constructor(code, operation, cause) {
        super(`${operation}: ${describe(code)} (${describeCause(cause)})`, { cause });
        this.name = "GitHubError";
        this.code = code;
        this.operation = operation;
    }
}
/**
 * The cause of a read whose answer arrived but failed Nibfin's check that it is
 * complete (a missing node, a count mismatch, no `data`). Its message keeps the detail,
 * such as `Read 1 of 2 dependencies`. `retryIncomplete` retries it (Proposal R4.37).
 */
class IncompleteAnswer extends Error {
    constructor(what) {
        super(what);
        this.name = "IncompleteAnswer";
    }
}
/** `GITHUB_READ_FAILED` of `operation` whose answer was incomplete (`what`). */
function incompleteRead(operation, what) {
    return new GitHubError("GITHUB_READ_FAILED", operation, new IncompleteAnswer(what));
}
/** True for a `GitHubError` whose cause is an `IncompleteAnswer`. */
function isIncompleteRead(error) {
    return error instanceof GitHubError && error.cause instanceof IncompleteAnswer;
}
function describe(code) {
    switch (code) {
        case "GITHUB_READ_FAILED":
            return "read failed";
        case "GITHUB_WRITE_UNCONFIRMED":
            return "write outcome unconfirmed";
        case "GITHUB_WRITE_REJECTED":
            return "write rejected";
    }
}
function describeCause(cause) {
    if (cause instanceof IncompleteAnswer) {
        return "incomplete answer";
    }
    if (!hasResponse(cause)) {
        return "no response";
    }
    const status = statusOf(cause);
    const limit = rateLimitOf(cause);
    const answer = status === undefined ? "GraphQL" : `HTTP ${status}`;
    return limit === undefined ? answer : `${answer}, rate limited (${limit})`;
}
/**
 * The rate limit GitHub answered with, if any: a 403/429 with
 * `x-ratelimit-remaining: 0` or a GraphQL `RATE_LIMITED` error is primary; a message
 * about a secondary rate limit is secondary. The throttling plugin throws a GraphQL
 * rate limit as an error with the response but no status.
 */
function rateLimitOf(error) {
    if (!hasResponse(error)) {
        return undefined;
    }
    const { response, message } = error;
    const status = statusOf(error);
    if (/\bsecondary rate\b/i.test(String(message))) {
        return "secondary";
    }
    const limited = status === 403 || status === 429;
    if (limited && response.headers?.["x-ratelimit-remaining"] === "0") {
        return "primary";
    }
    const errors = response.data?.errors;
    const graphql = Array.isArray(errors) ? errors : [];
    return graphql.some((item) => item?.type === "RATE_LIMITED") ? "primary" : undefined;
}
/** The HTTP status of an Octokit `RequestError`, if the error carries one. */
function statusOf(error) {
    if (typeof error === "object" && error !== null && "status" in error) {
        const { status } = error;
        return typeof status === "number" ? status : undefined;
    }
    return undefined;
}
/**
 * True when GitHub answered: Octokit sets `response` on the error. A network failure is
 * a `RequestError` whose `response` field is present but undefined.
 */
function hasResponse(error) {
    return (typeof error === "object" &&
        error !== null &&
        "response" in error &&
        error.response !== undefined);
}
/** A write whose outcome is unknown: no response, or a server error. */
function isUnknownOutcome(error) {
    const status = statusOf(error);
    return !hasResponse(error) || status === undefined || status >= 500;
}
/** Runs a read; any failure becomes `GITHUB_READ_FAILED` with the original cause. */
async function read(operation, run) {
    try {
        return await run();
    }
    catch (error) {
        throw asReadError(operation, error);
    }
}
/**
 * The request option of a read whose 404 means "absent" (pass it as `request`): that
 * 404 is an answer, so the client does not retry it (Proposal R4.39). Octokit does not
 * send it.
 */
const absentProbe = Object.freeze({ absent404: true });
/**
 * Runs a read where a 404 means "absent"; any other failure is `GITHUB_READ_FAILED`.
 * Its request carries `request: absentProbe`, so that 404 is not retried.
 */
async function readOptional(operation, run) {
    try {
        return await run();
    }
    catch (error) {
        if (hasResponse(error) && statusOf(error) === 404) {
            return undefined;
        }
        throw asReadError(operation, error);
    }
}
function asReadError(operation, error) {
    if (error instanceof GitHubError) {
        return error;
    }
    return new GitHubError("GITHUB_READ_FAILED", operation, error);
}

/**
 * True for a request that only reads GitHub: a GET or HEAD, or a GraphQL query
 * (Nibfin sends no GraphQL mutations; one would count as a write).
 */
function isReadRequest(method, url, body) {
    if (method === "GET" || method === "HEAD") {
        return true;
    }
    const path = new URL(url, "https://api.github.com").pathname;
    if (method !== "POST" || path !== "/graphql") {
        return false;
    }
    const query = body?.query;
    return typeof query !== "string" || !/^\s*mutation\b/.test(query);
}
/** How Octokit sends request options that went through `endpoint.merge`. */
function sentRequest(octokit, options) {
    const parse = octokit.request.endpoint.parse;
    const { method, url, body } = parse(options);
    return { method, url, body };
}
const clients = new WeakMap();
/**
 * Keeps the answers of read requests for the rest of the Job until the next write,
 * agent run or push (`freshReads`). GET requests (each page of a list) and GraphQL
 * queries are keyed by method, full URL, the `absent404` request option and, for
 * GraphQL, the body; identical reads share one answer, also while it is in flight.
 * Failed answers are not kept. Any other request clears the cache before it is sent
 * and again once it settled, so the confirm and read-back reads of a write go to
 * GitHub. Every caller gets its own copy of the data. `retry` is the client's Job log
 * and retry wait, kept with the cache for `retrySettingsOf`.
 */
function installReadCache(octokit, retry) {
    let entries = new Map();
    const clear = () => {
        entries = new Map();
    };
    clients.set(octokit, { clear, ...retry });
    octokit.hook.wrap("request", async (request, options) => {
        const { method, url, body } = sentRequest(octokit, options);
        if (!isReadRequest(method, url, body)) {
            clear();
            try {
                return await request(options);
            }
            finally {
                clear();
            }
        }
        const absent = options.request?.absent404;
        const flag = absent === true ? " absent404" : "";
        const data = body === undefined ? "" : JSON.stringify(body);
        const key = `${method} ${url}${flag} ${data}`;
        const cache = entries;
        let answer = cache.get(key);
        if (answer === undefined) {
            const pending = Promise.resolve(request(options));
            cache.set(key, pending);
            pending.catch(() => cache.delete(key));
            answer = pending;
        }
        const response = await answer;
        return { ...response, data: structuredClone(response.data) };
    });
}
/**
 * The Job log and retry wait of `client`; a client built without them (a hand-built
 * test fake) logs nothing and waits for real.
 */
function retrySettingsOf(client) {
    const entry = clients.get(client);
    return entry === undefined
        ? { log: () => { }, wait: (seconds) => setTimeout$1(seconds * 1000) }
        : { log: entry.log, wait: entry.wait };
}
/**
 * Drops every kept read of `client`, so the next reads see GitHub's current state.
 * Called at the start and end of every agent run, after every push and before the
 * post-stage route. A client without a cache is left alone.
 */
function freshReads(client) {
    clients.get(client)?.clear();
}

/**
 * Retries of one GitHub API call after its first attempt (Proposal R4.37): the same
 * for every call and every error.
 */
const maxRetries = 3;
const realWait = (seconds) => setTimeout$1(seconds * 1000);
/** Seconds a secondary rate limit waits when GitHub states no `retry-after`. */
const secondaryFallback = 60;
function headerOf(error, name) {
    const { response } = error;
    return Number(response.headers?.[name]);
}
/** The original error of a `GitHubError`; any other value as it is. */
function causeOf(error) {
    return error instanceof GitHubError ? error.cause : error;
}
/**
 * The seconds to wait before retry `k` (1 to `maxRetries`) after `error`: a secondary
 * rate limit waits `retry-after` (60 s without it), a primary one until
 * `x-ratelimit-reset` plus 1 s (60 s without it), anything else `k²` seconds.
 */
function retryDelay(error, k, now = Date.now()) {
    const cause = causeOf(error);
    const limit = rateLimitOf(cause);
    if (limit === "secondary") {
        const retryAfter = headerOf(cause, "retry-after");
        return retryAfter > 0 ? retryAfter : secondaryFallback;
    }
    if (limit === "primary") {
        const reset = headerOf(cause, "x-ratelimit-reset");
        if (!Number.isFinite(reset)) {
            return secondaryFallback;
        }
        return Math.max(Math.ceil(reset - now / 1000) + 1, 0);
    }
    return k * k;
}
const incompleteCause = "incomplete answer";
/**
 * What failed, for the Job log: `incomplete answer`, the rate-limit kind,
 * `no response`, `GraphQL error` or the HTTP status. Never a message, header or body.
 */
function retryCause(error) {
    const cause = causeOf(error);
    if (cause instanceof IncompleteAnswer) {
        return incompleteCause;
    }
    const limit = rateLimitOf(cause);
    if (limit !== undefined) {
        return `${limit} rate limit`;
    }
    if (!hasResponse(cause)) {
        return "no response";
    }
    const status = statusOf(cause);
    return status === undefined ? "GraphQL error" : `HTTP ${status}`;
}
/**
 * `GitHub <method> <path>` of the request an Octokit error carries (the path only,
 * never the query string), or `fallback` when it carries none.
 */
function requestName(error, fallback) {
    const request = causeOf(error)
        ?.request;
    if (typeof request?.method !== "string" || typeof request.url !== "string") {
        return fallback;
    }
    return `GitHub ${request.method} ${new URL(request.url).pathname}`;
}
/** The Job-log line when a call gives up. */
function giveUpLine(what, cause) {
    return `${what}: ${cause}; not retrying after ${maxRetries} retries`;
}
/**
 * Logs that `what` gives up with `cause` after the last retry, with the client's log
 * (a client without one logs nothing).
 */
function logGiveUp(client, what, cause) {
    retrySettingsOf(client).log(giveUpLine(what, cause));
}
async function announceAndWait(settings, what, error, k, cause) {
    const seconds = retryDelay(error, k);
    settings.log(`${what} (retry ${k} of ${maxRetries}): ${cause}; waiting ${seconds} s`);
    await settings.wait(seconds);
}
/**
 * Logs retry `k` of `what` with `cause` and waits `retryDelay(error, k)` with the
 * client's log and wait (a client without them logs nothing and waits for real).
 * Returns the client's log.
 */
async function waitToRetry(client, what, error, k, cause = retryCause(error)) {
    const settings = retrySettingsOf(client);
    await announceAndWait(settings, what, error, k, cause);
    return settings.log;
}
/** Incomplete-answer errors a `retryIncomplete` already gave up on. */
const exhausted = new WeakSet();
/**
 * Runs the read `run` and retries it when its answer arrived but was incomplete
 * (`GITHUB_READ_FAILED` caused by an `IncompleteAnswer`), up to `maxRetries` times
 * (Proposal R4.37). Each retry is logged as `GitHub <operation> (retry k of 3):
 * incomplete answer; waiting s s`, waits `retryDelay` and drops the client's kept
 * reads (`freshReads`), so the next attempt reaches GitHub. After the last retry it
 * logs the give-up line and throws the last error unchanged. Any other error (a
 * request error the request hook already retried, a GraphQL `errors` answer, a
 * definite answer such as "is a pull request") is thrown at once, so retries never
 * multiply; so is an incomplete answer a nested `retryIncomplete` already gave up on.
 */
async function retryIncomplete(client, operation, run) {
    const what = `GitHub ${operation}`;
    const retriable = (error) => isIncompleteRead(error) && !exhausted.has(error);
    for (let k = 1; k <= maxRetries; k += 1) {
        try {
            return await run();
        }
        catch (error) {
            if (!retriable(error)) {
                throw error;
            }
            await waitToRetry(client, what, error, k, incompleteCause);
            freshReads(client);
        }
    }
    try {
        return await run();
    }
    catch (error) {
        if (retriable(error)) {
            logGiveUp(client, what, incompleteCause);
            exhausted.add(error);
        }
        throw error;
    }
}
/** A GraphQL answer whose `errors` is a non-empty list. */
function hasGraphqlErrors(data) {
    const errors = Object(data).errors;
    return Array.isArray(errors) && errors.length > 0;
}
/**
 * Retries every read (GET, HEAD, GraphQL query) on any error up to `maxRetries`
 * times, logging each retry and waiting `retryDelay`. A GraphQL answer with `errors`
 * counts as an error; after the last retry it is returned as it is. A 404 of a request
 * sent with `request: { absent404: true }` is an answer ("absent") and is not retried.
 * Writes pass through; `write()` retries them. Install it before the read cache, so
 * identical reads still share one answer. It sees only requests: an answer that
 * arrives but fails its caller's completeness check is retried at call level by
 * `retryIncomplete`.
 */
function installReadRetries(octokit, log, wait) {
    octokit.hook.wrap("request", async (request, options) => {
        const { method, url, body } = sentRequest(octokit, options);
        if (!isReadRequest(method, url, body)) {
            return request(options);
        }
        const what = `GitHub ${method} ${new URL(url).pathname}`;
        const absent404 = Object(options.request).absent404 === true;
        const attempt = async () => {
            try {
                const response = await request(options);
                return hasGraphqlErrors(response.data)
                    ? { ok: false, error: undefined, cause: "GraphQL error", response }
                    : { ok: true, response };
            }
            catch (error) {
                if (absent404 && statusOf(error) === 404) {
                    throw error;
                }
                return { ok: false, error, cause: retryCause(error) };
            }
        };
        for (let k = 1; k <= maxRetries; k += 1) {
            const result = await attempt();
            if (result.ok) {
                return result.response;
            }
            await announceAndWait({ log, wait }, what, result.error, k, result.cause);
        }
        const last = await attempt();
        if (last.ok) {
            return last.response;
        }
        log(giveUpLine(what, last.cause));
        if (last.response !== undefined) {
            return last.response;
        }
        throw last.error;
    });
}

/** `@octokit/rest` with the official throttling plugin. */
const NibfinOctokit = Octokit.plugin(throttling);
const noLog = () => { };
/** The throttling plugin never retries by itself: every retry is Nibfin's (R4.37). */
const noPluginRetry = () => false;
function buildOctokit(token, options, log) {
    const { wait = realWait, ...octokitOptions } = options;
    const octokit = new NibfinOctokit({
        userAgent: "nibfin-core",
        ...octokitOptions,
        auth: token,
        throttle: {
            ...octokitOptions.throttle,
            onRateLimit: noPluginRetry,
            onSecondaryRateLimit: noPluginRetry,
        },
    });
    // Installed first, so it runs inside the read cache: one retry loop per sent read.
    installReadRetries(octokit, log, wait);
    installReadCache(octokit, { log, wait });
    return octokit;
}
function withActor(octokit, actor) {
    return Object.assign(octokit, {
        actor: Object.freeze({ id: actor.id, login: actor.login }),
    });
}
/** The account a token belongs to, read with `GET /user` (#674). */
async function readActor(client) {
    const { data } = await read("read the token's user", () => client.request("GET /user"));
    return { id: Number(data.id), login: data.login };
}
/**
 * A client for `token` that writes as the token's own account, read once with
 * `GET /user` through the same instance; valid for a user's gh login token, not for
 * `GITHUB_TOKEN`.
 */
async function connectClient(token, options = {}, log = noLog) {
    const octokit = buildOctokit(token, options, log);
    return withActor(octokit, await readActor(octokit));
}
/** The account `login`, read with `GET /users/{login}`. */
async function readUser(client, login) {
    const { data } = await read(`read the user ${login}`, () => client.request("GET /users/{username}", { username: login }));
    return { id: Number(data.id), login: data.login };
}
/**
 * A client for `token` that writes as the account `login`, read once with
 * `GET /users/{login}` through the same instance. For a token whose account
 * `GET /user` cannot read, such as a job's `GITHUB_TOKEN`, which writes as
 * `github-actions[bot]`.
 */
async function connectAs(token, login, options = {}, log = noLog) {
    const octokit = buildOctokit(token, options, log);
    return withActor(octokit, await readUser(octokit, login));
}

/** `owner/repo#n`, used in operation names. */
function formatIssue(issue) {
    return `${issue.owner}/${issue.repo}#${issue.number}`;
}

/**
 * Runs a write and retries it on any error up to `maxRetries` times (Proposal
 * R4.37–R4.38). A 4xx that `recover` shows as the intended state is success and is
 * not retried. Before each re-send the client's retry wait passes, then `confirm`
 * re-reads GitHub: a write that already took effect is not sent again. A failing
 * pre-read ends the write without a re-send. After the last retry an unknown outcome
 * (no response, or 5xx) is re-read once more and is `GITHUB_WRITE_UNCONFIRMED`; any
 * other failure is `GITHUB_WRITE_REJECTED`. The cause is the write's last error.
 */
async function write(client, operation, run, recovery) {
    for (let k = 1;; k += 1) {
        let error;
        try {
            return await run();
        }
        catch (caught) {
            error = caught;
        }
        const unknown = isUnknownOutcome(error);
        if (!unknown) {
            const recovered = await recovery.recover?.(error);
            if (recovered !== undefined) {
                return recovered;
            }
        }
        const code = unknown ? "GITHUB_WRITE_UNCONFIRMED" : "GITHUB_WRITE_REJECTED";
        const what = requestName(error, operation);
        if (k > maxRetries) {
            const confirmed = unknown
                ? await recovery.confirm().catch(() => undefined)
                : undefined;
            if (confirmed !== undefined) {
                return confirmed;
            }
            logGiveUp(client, what, retryCause(error));
            throw new GitHubError(code, operation, error);
        }
        await waitToRetry(client, what, error, k);
        let confirmed;
        try {
            confirmed = await recovery.confirm();
        }
        catch {
            throw new GitHubError(code, operation, error);
        }
        if (confirmed !== undefined) {
            return confirmed;
        }
    }
}

/** `GET /repos/{owner}/{repo}`; within a run the read cache shares one request. */
async function readRepo$1(client, repo) {
    const { data } = await read(`read ${repo.owner}/${repo.repo}`, () => client.request("GET /repos/{owner}/{repo}", { ...repo }));
    return data;
}
/** The default branch of `repo`. */
async function readDefaultBranch(client, repo) {
    return (await readRepo$1(client, repo)).default_branch;
}
/**
 * Dispatches `workflow` of `repo` on its default branch with `inputs` and returns
 * the new run's URL when GitHub reports it. A dispatch only wakes an Issue, so a
 * repeated one is harmless (R4.35), and it cannot be confirmed by a re-read: any
 * failure is re-sent without a pre-read up to `maxRetries` times. Then no response
 * or a 5xx is `GITHUB_WRITE_UNCONFIRMED`, any other failure `GITHUB_WRITE_REJECTED`.
 */
async function dispatchWorkflow(client, repo, workflow, inputs) {
    const ref = await readDefaultBranch(client, repo);
    return write(client, `dispatch ${workflow} of ${repo.owner}/${repo.repo}`, async () => {
        const { data } = await client.request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", { ...repo, workflow_id: workflow, ref, inputs, return_run_details: true });
        return data?.html_url;
    }, { confirm: () => Promise.resolve(undefined) });
}
/**
 * Sends the `repository_dispatch` event `eventType` to `repo` with `payload` as its
 * `client_payload`. Like `dispatchWorkflow`, it cannot be confirmed by a re-read and
 * a repeated event is harmless (a repeated retest), so any failure is re-sent
 * without a pre-read up to `maxRetries` times. Then no response or a 5xx is
 * `GITHUB_WRITE_UNCONFIRMED`, any other failure `GITHUB_WRITE_REJECTED`.
 */
async function dispatchRepository(client, repo, eventType, payload) {
    await write(client, `send ${eventType} to ${repo.owner}/${repo.repo}`, async () => {
        await client.request("POST /repos/{owner}/{repo}/dispatches", {
            ...repo,
            event_type: eventType,
            client_payload: payload,
        });
    }, { confirm: () => Promise.resolve(undefined) });
}

/** The branch that delivers Issue `n`. */
function deliveryBranch(issueNumber) {
    return `nibfin/issue-${issueNumber}`;
}
/** The branch of the `k`-th fix after a CD failure of Issue `n`. */
function cdFixBranch(issueNumber, k) {
    return `${deliveryBranch(issueNumber)}-cd-${k}`;
}
const issueBranchPattern = /^nibfin\/issue-([1-9]\d*)(?:-cd-[1-9]\d*)?$/;
/**
 * The Issue number of a delivery branch `nibfin/issue-<n>` or a CD fix branch
 * `nibfin/issue-<n>-cd-<k>`; `undefined` for any other branch.
 */
function issueOfBranch(branch) {
    const match = issueBranchPattern.exec(branch);
    return match === null ? undefined : Number(match[1]);
}
function summarizePullRequest(pull) {
    return {
        number: pull.number,
        state: pull.state === "open" ? "open" : "closed",
        merged: pull.merged_at !== null,
        headRef: pull.head.ref,
        headSha: pull.head.sha,
        baseRef: pull.base.ref,
        mergeCommitSha: pull.merge_commit_sha,
        url: pull.html_url,
    };
}

/**
 * The collaborator permission of `login` on the repository as GitHub states it
 * (`admin`, `write`, `read` or `none`; `maintain` reads as `write`). A 404 (not a
 * collaborator) is `none`; any other failure is `GITHUB_READ_FAILED`.
 */
async function readCollaboratorPermission(client, repo, login) {
    const answer = await readOptional(`read the permission of ${login} on ${repo.owner}/${repo.repo}`, () => client.request("GET /repos/{owner}/{repo}/collaborators/{username}/permission", {
        ...repo,
        username: login,
        request: absentProbe,
    }));
    return answer?.data.permission ?? "none";
}
/** Whether a collaborator permission gives write access: `admin` or `write`. */
function isWritePermission(permission) {
    return permission === "admin" || permission === "write";
}
/**
 * Whether `login` has write access to the repository: its collaborator permission
 * (`readCollaboratorPermission`) is `admin` or `write`. A 404 (not a collaborator) is
 * no access; any other failure is `GITHUB_READ_FAILED`.
 */
async function hasWritePermission(client, repo, login) {
    return isWritePermission(await readCollaboratorPermission(client, repo, login));
}
/**
 * The merged pull requests whose `merge_commit_sha` is `sha` (#771). GitHub's
 * `GET …/commits/{sha}/pulls` names only the pull request that introduced a commit,
 * so a second pull request merged to the same commit (main did not move) is found
 * here: the closed pull requests, most recently updated first, page by page, up to
 * the first page that reaches one updated before the commit's committer date (any
 * pull request merged to `sha` was merged, so updated, after the commit existed).
 */
async function readPullRequestsMergedAt(client, repo, sha) {
    const name = `${repo.owner}/${repo.repo}`;
    const { data: commit } = await read(`read commit ${name}@${sha}`, () => client.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
        ...repo,
        commit_sha: sha,
    }));
    const since = Date.parse(commit.committer.date);
    const pulls = await read(`list closed pull requests of ${name}`, () => client.paginate("GET /repos/{owner}/{repo}/pulls", {
        ...repo,
        state: "closed",
        sort: "updated",
        direction: "desc",
        per_page: 100,
    }, (response, done) => {
        if (response.data.some((pull) => Date.parse(pull.updated_at) < since)) {
            done();
        }
        return response.data;
    }));
    return pulls
        .filter((pull) => pull.merged_at !== null && pull.merge_commit_sha === sha)
        .map(summarizePullRequest);
}

/** A failure that names its cause and keeps the tool's original exit code. */
class AgentError extends Error {
    code;
    exitCode;
    loginCommand;
    usageLimitReset;
    output;
    constructor(code, message, details) {
        super(message, { cause: details.cause });
        this.name = "AgentError";
        this.code = code;
        this.exitCode = details.exitCode;
        this.loginCommand = details.loginCommand;
        this.usageLimitReset = details.usageLimitReset;
        this.output = details.output;
    }
}

promisify(execFile);

function describeExit(status) {
    return status.exitCode === null
        ? `signal ${status.signal}`
        : `exit code ${status.exitCode}`;
}
function start(request, stdio) {
    return spawn(request.command.command, [...request.command.args, ...request.args], {
        cwd: request.cwd,
        env: request.env,
        stdio,
    });
}
function waitForExit(child) {
    return new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (exitCode, signal) => {
            resolve({ exitCode, signal });
        });
    });
}
/**
 * Feeds `stdin` to the process, forwards its output unchanged and reports each
 * stdout line to `onLine`.
 */
function runStreaming(request) {
    const child = start(request, "pipe");
    const exit = waitForExit(child);
    // A CLI that stops reading its prompt reports that through its exit status.
    pipeline(Readable.from([request.stdin]), child.stdin, () => undefined);
    child.stdout.on("data", (chunk) => request.stdout.write(chunk));
    child.stderr.on("data", (chunk) => request.stderr.write(chunk));
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    });
    return exit;
}
/** Runs the process for its exit status only; its output is discarded. */
function runQuiet(request) {
    return waitForExit(start(request, "ignore"));
}

/** A stage that stopped for a named reason. `cause` keeps the original error, if any. */
class StageError extends Error {
    code;
    constructor(code, message, cause) {
        super(message, { cause });
        this.name = "StageError";
        this.code = code;
    }
}
/**
 * A stage that exited 0 without progress while the route still asks for the same
 * stage and reason (#674). `temporary` when waiting is likely to fix it (GitHub
 * still computing mergeability).
 */
class NoProgressError extends StageError {
    temporary;
    constructor(message, temporary) {
        super("STAGE_NO_PROGRESS", message);
        this.name = "NoProgressError";
        this.temporary = temporary;
    }
}

function invalid$1(field, reason) {
    return new StageError("STAGE_INPUT_INVALID", `${field} ${reason}`);
}
const repoPattern = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/;
const numberPattern = /^[1-9]\d*$/;
function required(value, field) {
    if (value === undefined || value.trim() === "") {
        throw invalid$1(field, "is missing");
    }
    return value;
}
function positiveInteger(value, field) {
    const text = required(value, field);
    const number = Number(text);
    if (!numberPattern.test(text) || !Number.isSafeInteger(number)) {
        throw invalid$1(field, "must be a positive integer");
    }
    return number;
}
function readRepo(value, field) {
    const match = repoPattern.exec(required(value, field));
    if (match === null) {
        throw invalid$1(field, "must be <owner>/<repo>");
    }
    return { owner: match[1], repo: match[2] };
}

/** Every workflow Nibfin installs has a name starting with this prefix. */
const nibfinWorkflowPrefix = "Nibfin ·";
/**
 * The run name of an Issue's stage or route run (#674):
 * `Nibfin · <owner>/<repo>#<n> · <stage>`.
 */
function nibfinRunTitle(repo, issue, stage) {
    return `${nibfinWorkflowPrefix} ${repo.owner}/${repo.repo}#${issue} · ${stage}`;
}

/**
 * One GraphQL query; GraphQL `errors` or a missing `data` fail it with
 * `GITHUB_READ_FAILED`, so no partial answer is used. A missing `data` is an
 * incomplete answer (`incompleteRead`), which `retryIncomplete` retries.
 */
async function queryGraphql(client, operation, query, variables) {
    const answer = await read(operation, () => client.request("POST /graphql", { query, variables }));
    const { data, errors } = answer.data;
    if (errors !== undefined) {
        // The request hook already retried this answer (R4.37); it is not retried again.
        const first = errors[0]?.message;
        const reason = typeof first === "string" ? first : "GraphQL returned no data";
        throw new GitHubError("GITHUB_READ_FAILED", operation, new Error(reason));
    }
    if (data === undefined || data === null) {
        throw incompleteRead(operation, "GraphQL returned no data");
    }
    return data;
}
/** How many fix branches one query probes for pull requests. */
const fixBatch = 3;
const pullsFragment = `fragment Pulls on PullRequestConnection {
  pageInfo { hasNextPage }
  nodes {
    number state merged headRefName headRefOid baseRefName url isCrossRepository
    mergeCommit { oid }
  }
}`;
const commentsFragment = `fragment Comments on IssueCommentConnection {
  pageInfo { hasNextPage endCursor }
  nodes {
    fullDatabaseId body url
    author { ... on User { databaseId } ... on Bot { databaseId } }
    userContentEdits(first: 1) { totalCount }
  }
}`;
const dependencyFragment = `fragment Dependency on Issue {
  number state url
  repository { name owner { login } }
  labels(first: 100) { totalCount nodes { name } }
}`;
const fixVariables = Array.from({ length: fixBatch }, (_, i) => `$fix${i + 1}: String!`);
const fixFields = Array.from({ length: fixBatch }, (_, i) => `fix${i + 1}: pullRequests(headRefName: $fix${i + 1}, first: 100) { ...Pulls }`);
const recordQuery = `query IssueRecord(
  $owner: String!, $repo: String!, $number: Int!
  $branch: String!, $ref: String!, $fixQuery: String!, ${fixVariables.join(", ")}
) {
  repository(owner: $owner, name: $repo) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue {
        state stateReason url title body
        labels(first: 100) { totalCount nodes { name } }
        assignees(first: 100) { totalCount nodes { databaseId login } }
        issueDependenciesSummary { totalBlockedBy }
        blockedBy(first: 100) { nodes { ...Dependency } }
        comments(first: 100) { ...Comments }
      }
    }
    delivery: pullRequests(headRefName: $branch, first: 100) { ...Pulls }
    ref(qualifiedName: $ref) { name }
    fixRefs: refs(refPrefix: "refs/heads/nibfin/", query: $fixQuery, first: 100) {
      pageInfo { hasNextPage }
      nodes { name }
    }
    ${fixFields.join("\n    ")}
  }
}
${pullsFragment}
${commentsFragment}
${dependencyFragment}`;
const fixQuery = `query IssueFixBranches(
  $owner: String!, $repo: String!, ${fixVariables.join(", ")}
) {
  repository(owner: $owner, name: $repo) {
    ${fixFields.join("\n    ")}
  }
}
${pullsFragment}`;
const commentsQuery = `query IssueComments(
  $owner: String!, $repo: String!, $number: Int!, $cursor: String!
) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) { comments(first: 100, after: $cursor) { ...Comments } }
  }
}
${commentsFragment}`;
/** The nodes of a connection; a missing node or a count GitHub left out fails. */
function allNodes(operation, what, nodes, total) {
    const present = nodes.filter((node) => node !== null);
    if (present.length !== total) {
        throw incompleteRead(operation, `Read ${present.length} of ${total} ${what}`);
    }
    return present;
}
function names(operation, what, labels) {
    return allNodes(operation, what, labels.nodes, labels.totalCount).map((n) => n.name);
}
function dependency(operation, node) {
    return {
        owner: node.repository.owner.login,
        repo: node.repository.name,
        number: node.number,
        state: node.state === "CLOSED" ? "closed" : "open",
        labels: names(operation, `labels of #${node.number}`, node.labels),
        url: node.url,
    };
}
/** The dependency list checked against the Issue's summary count. */
function dependencies(operation, nodes, total) {
    const present = allNodes(operation, "dependencies", nodes, total);
    return present.map((node) => dependency(operation, node));
}
/**
 * The pull requests of one head branch whose head is in this repository (like REST's
 * `head: owner:branch`), newest first.
 */
function pullRequests(operation, branch, pulls) {
    if (pulls.pageInfo.hasNextPage) {
        throw incompleteRead(operation, `More than 100 pull requests of ${branch}`);
    }
    return pulls.nodes
        .filter((pull) => pull !== null && !pull.isCrossRepository)
        .filter((pull) => pull.headRefName === branch)
        .map((pull) => ({
        number: pull.number,
        state: pull.state === "OPEN" ? "open" : "closed",
        merged: pull.merged,
        headRef: pull.headRefName,
        headSha: pull.headRefOid,
        baseRef: pull.baseRefName,
        mergeCommitSha: pull.mergeCommit?.oid ?? null,
        url: pull.url,
    }))
        .toSorted((a, b) => b.number - a.number);
}
function comment(operation, node) {
    const id = Number(node.fullDatabaseId);
    if (node.fullDatabaseId === null || !Number.isSafeInteger(id) || id <= 0) {
        throw incompleteRead(operation, `GraphQL returned comment id ${node.fullDatabaseId}`);
    }
    return {
        id,
        authorId: node.author?.databaseId ?? null,
        body: node.body,
        url: node.url,
        versions: Math.max(1, node.userContentEdits?.totalCount ?? 0),
    };
}
/** Every comment: the first page from the record, follow-up pages past 100. */
async function allComments(client, issue, operation, first) {
    const nodes = [...first.nodes];
    let page = first.pageInfo;
    while (page.hasNextPage) {
        const data = await queryGraphql(client, operation, commentsQuery, {
            ...variablesOf(issue),
            cursor: page.endCursor,
        });
        const comments = data.repository?.issue?.comments;
        if (comments === undefined) {
            throw incompleteRead(operation, "GraphQL returned no comments");
        }
        nodes.push(...comments.nodes);
        page = comments.pageInfo;
    }
    if (nodes.includes(null)) {
        throw incompleteRead(operation, "GraphQL returned a missing comment");
    }
    return nodes.map((node) => comment(operation, node));
}
function variablesOf(issue) {
    return { owner: issue.owner, repo: issue.repo, number: issue.number };
}
function fixNames(issue, from) {
    return Object.fromEntries(Array.from({ length: fixBatch }, (_, i) => [
        `fix${i + 1}`,
        cdFixBranch(issue.number, from + i),
    ]));
}
/**
 * The delivery branch and every fix branch `-cd-1`, `-cd-2`, … up to the first `k` that
 * has neither a pull request nor a ref; batches after the first are queried in turn.
 */
async function issueBranches(client, issue, operation, repository) {
    const delivery = {
        name: deliveryBranch(issue.number),
        exists: repository.ref !== null,
        pullRequests: pullRequests(operation, deliveryBranch(issue.number), repository.delivery),
    };
    if (repository.fixRefs.pageInfo.hasNextPage) {
        throw incompleteRead(operation, "More than 100 fix branches");
    }
    // Names under `refs/heads/nibfin/`; the query may match more, only exact names count.
    const refs = new Set(repository.fixRefs.nodes.flatMap((node) => node === null ? [] : [`nibfin/${node.name}`]));
    const fixes = [];
    let batch = repository;
    for (;;) {
        const from = fixes.length + 1;
        const branches = fixNames(issue, from);
        for (const [alias, name] of Object.entries(branches)) {
            const pulls = batch[alias];
            if (pulls === undefined) {
                throw incompleteRead(operation, `GraphQL returned no pull requests of ${name}`);
            }
            const probe = {
                name,
                exists: refs.has(name),
                pullRequests: pullRequests(operation, name, pulls),
            };
            if (!probe.exists && probe.pullRequests.length === 0) {
                return {
                    delivery,
                    fixes,
                    current: fixes.at(-1) ?? delivery,
                    nextFixBranch: name,
                };
            }
            fixes.push(probe);
        }
        const next = fixNames(issue, fixes.length + 1);
        const data = await queryGraphql(client, operation, fixQuery, { owner: issue.owner, repo: issue.repo, ...next });
        batch = data.repository ?? {};
    }
}
/**
 * Reads an Issue with one GraphQL query (follow-up queries only past 100 comments or
 * past the first fix branches): state, state reason, text, labels, Assignees, Blocked
 * by (checked against `issueDependenciesSummary.totalBlockedBy`), all comments, and
 * the pull requests and refs of its delivery and CD fix branches. A pull request
 * number fails with `GITHUB_READ_FAILED` at once. A missing Issue or an incomplete
 * list is an incomplete answer: `retryIncomplete` retries the whole read (follow-up
 * queries included) with fresh reads before it fails with `GITHUB_READ_FAILED`.
 * Repeated calls in a Job send the same request, so the read cache answers them.
 */
async function readIssueRecord(client, issue) {
    const ref = { owner: issue.owner, repo: issue.repo, number: issue.number };
    const operation = `read ${formatIssue(ref)}`;
    return retryIncomplete(client, operation, () => issueRecord(client, ref, operation));
}
async function issueRecord(client, ref, operation) {
    const branch = deliveryBranch(ref.number);
    const data = await queryGraphql(client, operation, recordQuery, {
        ...variablesOf(ref),
        branch,
        ref: `refs/heads/${branch}`,
        fixQuery: `issue-${ref.number}-cd-`,
        ...fixNames(ref, 1),
    });
    const node = data.repository?.issueOrPullRequest;
    if (node === null || node === undefined || node.__typename !== "Issue") {
        if (node?.__typename === "PullRequest") {
            // A definite answer, not an incomplete one: it is not retried.
            const cause = new Error(`${formatIssue(ref)} is a pull request`);
            throw new GitHubError("GITHUB_READ_FAILED", operation, cause);
        }
        // A just-created Issue can read as missing until GraphQL catches up: retried.
        throw incompleteRead(operation, `${formatIssue(ref)} was not found`);
    }
    const assignees = node.assignees;
    return {
        issue: ref,
        state: node.state === "CLOSED" ? "closed" : "open",
        stateReason: node.stateReason === null ? null : node.stateReason.toLowerCase(),
        url: node.url,
        title: node.title,
        body: node.body,
        labels: names(operation, "labels", node.labels),
        assignees: allNodes(operation, "Assignees", assignees.nodes, assignees.totalCount).map((user) => ({ id: user.databaseId, login: user.login })),
        blockedBy: dependencies(operation, node.blockedBy.nodes, node.issueDependenciesSummary.totalBlockedBy),
        comments: await allComments(client, ref, operation, node.comments),
        branches: await issueBranches(client, ref, operation, data.repository),
    };
}

/**
 * The Issues of the open or merged pull requests of `GET /commits/{sha}/pulls` whose
 * head is `nibfin/issue-<n>[-cd-<k>]` (the head ref stays after the branch is
 * deleted), in GitHub's order, without repeats.
 */
async function associatedIssues(client, repo, sha) {
    const operation = `list pull requests of ${repo.owner}/${repo.repo}@${sha}`;
    const pulls = await read(operation, () => client.paginate("GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls", {
        ...repo,
        commit_sha: sha,
        per_page: 100,
    }));
    const issues = pulls
        .filter((pull) => pull.state === "open" || pull.merged_at !== null)
        .map((pull) => issueOfBranch(pull.head.ref))
        .filter((issue) => issue !== undefined);
    return [...new Set(issues)];
}
/**
 * Every Issue of commit `sha`, without repeats: those of `GET /commits/{sha}/pulls`
 * (see `associatedIssues`), then those of every merged pull request whose
 * `merge_commit_sha` is the commit (a pull request that merged without moving the
 * base is not associated with it, #771). Empty when it belongs to no Issue.
 */
async function issuesOfCommit(client, repo, sha) {
    const issues = await associatedIssues(client, repo, sha);
    for (const pull of await readPullRequestsMergedAt(client, repo, sha)) {
        const issue = issueOfBranch(pull.headRef);
        if (issue !== undefined) {
            issues.push(issue);
        }
    }
    return [...new Set(issues)];
}

/** The Issue comment `id` of `repo`, by `GET …/issues/comments/{comment_id}`. */
async function readIssueComment(client, repo, id) {
    const { data } = await read(`read comment ${id} of ${repo.owner}/${repo.repo}`, () => client.request("GET /repos/{owner}/{repo}/issues/comments/{comment_id}", {
        owner: repo.owner,
        repo: repo.repo,
        comment_id: id,
    }));
    return { id, body: data.body ?? "", url: data.html_url, updatedAt: data.updated_at };
}
/**
 * When `label` was last removed from `issue`: the latest `created_at` of an
 * `unlabeled` event for it among all the Issue's events
 * (`GET /repos/{owner}/{repo}/issues/{issue_number}/events`, every page), or `null`
 * when it never was.
 */
async function readLastUnlabeled(client, issue, label) {
    const events = await read(`list events of ${formatIssue(issue)}`, () => client.paginate("GET /repos/{owner}/{repo}/issues/{issue_number}/events", {
        owner: issue.owner,
        repo: issue.repo,
        issue_number: issue.number,
        per_page: 100,
    }));
    let latest = null;
    for (const event of events) {
        const name = event.label?.name;
        if (event.event !== "unlabeled" || name !== label) {
            continue;
        }
        if (latest === null || Date.parse(event.created_at) > Date.parse(latest)) {
            latest = event.created_at;
        }
    }
    return latest;
}

/** The Issue labels Nibfin reads and writes (Proposal §4). */
const nibfinLabels = {
    /** Set by Nibfin when a person must act; removing it is the go-ahead (#674). */
    pending: "pending",
};

/** The marker that starts a Nibfin comment: `<!-- nibfin:<key> -->`. */
function commentMarker(key) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) {
        throw new TypeError(`Invalid comment key: ${key}`);
    }
    return `<!-- nibfin:${key} -->`;
}
/** The oldest of `comments` by the actor that starts with the marker of `key`. */
function oldestMarked(comments, actor, marker) {
    return comments
        .filter((comment) => comment.authorId === actor && comment.body.startsWith(marker))
        .toSorted((a, b) => a.id - b.id)
        .at(0);
}
/**
 * The actor's oldest marked comment of `key` on Issue `issue` as the Issue record reads
 * it, with its number of versions.
 */
async function readMarkedComment(client, issue, key) {
    const marker = commentMarker(key);
    const { comments } = await readIssueRecord(client, issue);
    return oldestMarked(comments, client.actor.id, marker);
}
/**
 * The oldest comment on `target` that starts with the marker of `key` and was written by
 * the client's actor. Comments of other authors never count. An Issue's comments come
 * from its Issue record; a pull request's from the REST comment list.
 */
async function findMarkedComment(client, target, key, on = "issue") {
    const marker = commentMarker(key);
    if (on === "issue") {
        const found = await readMarkedComment(client, target, key);
        return found === undefined
            ? undefined
            : { id: found.id, body: found.body, url: found.url };
    }
    const comments = await read(`list comments of ${formatIssue(target)}`, () => client.paginate("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        owner: target.owner,
        repo: target.repo,
        issue_number: target.number,
        per_page: 100,
    }));
    return oldestMarked(comments.map(({ id, user, body, html_url }) => ({
        id,
        authorId: user?.id ?? null,
        body: body ?? "",
        url: html_url,
    })), client.actor.id, marker);
}
/**
 * Writes `<marker>\n<body>` as the actor's marked comment of `key`: updates the oldest
 * one in place (others are left alone), creates it when there is none, and skips the
 * write when the body is unchanged. Returns the comment as re-read.
 */
async function upsertMarkedComment(client, target, key, body, on = "issue") {
    const desired = `${commentMarker(key)}\n${body}`;
    const find = () => findMarkedComment(client, target, key, on);
    const existing = await find();
    if (existing?.body === desired) {
        return existing;
    }
    const confirm = async () => {
        const comment = await find();
        return comment?.body === desired ? comment : undefined;
    };
    const operation = `write ${key} comment on ${formatIssue(target)}`;
    await write(client, operation, async () => {
        if (existing) {
            await client.request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", {
                owner: target.owner,
                repo: target.repo,
                comment_id: existing.id,
                body: desired,
            });
        }
        else {
            await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
                owner: target.owner,
                repo: target.repo,
                issue_number: target.number,
                body: desired,
            });
        }
        return true;
    }, { confirm: async () => ((await confirm()) ? true : undefined) });
    const comment = await find();
    if (!comment) {
        throw new GitHubError("GITHUB_WRITE_UNCONFIRMED", operation, new Error("The comment was not found after the write"));
    }
    return comment;
}
async function readLabels(client, issue) {
    return (await readIssueRecord(client, issue)).labels;
}
/**
 * Adds and removes labels so the Issue ends with every `add` and no `remove`; labels
 * already in place are not written again. Returns the labels as re-read.
 */
async function setLabels(client, issue, changes) {
    const add = changes.add ?? [];
    const remove = changes.remove ?? [];
    if (add.some((label) => remove.includes(label))) {
        throw new TypeError("A label cannot be both added and removed");
    }
    const current = await readLabels(client, issue);
    const toAdd = add.filter((label) => !current.includes(label));
    const toRemove = remove.filter((label) => current.includes(label));
    const where = formatIssue(issue);
    if (toAdd.length > 0) {
        await write(client, `add labels to ${where}`, async () => {
            await client.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
                owner: issue.owner,
                repo: issue.repo,
                issue_number: issue.number,
                labels: toAdd,
            });
            return true;
        }, {
            confirm: async () => {
                const labels = await readLabels(client, issue);
                return toAdd.every((label) => labels.includes(label)) ? true : undefined;
            },
        });
    }
    for (const label of toRemove) {
        const absent = async () => (await readLabels(client, issue)).includes(label) ? undefined : true;
        await write(client, `remove label ${label} from ${where}`, async () => {
            await client.request("DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}", {
                owner: issue.owner,
                repo: issue.repo,
                issue_number: issue.number,
                name: label,
            });
            return true;
        }, {
            confirm: absent,
            recover: async (error) => (statusOf(error) === 404 ? absent() : undefined),
        });
    }
    return readLabels(client, issue);
}

// The repair record and decision comment: the contract gh-nibfin parses (Proposal
// R4.49, R4.51, R9.52). See "Repair stage" in README.md.
/** The comment key of the note that asks a person to act (`requestPerson`). */
const pendingCommentKey = "pending";
/** The comment key of the Scope stage's comment on a request. */
const scopeRequestCommentKey = "scope-request";
/** The comment key of the repair record (`<!-- nibfin:repair -->`). */
const repairCommentKey = "repair";
/** What a stop says when a repair Job under an `amend` record ended unfinished. */
const amendmentNote = "The amendment in the repair record may be partly applied: check the Issue body " +
    "and its Blocked by.";
const statuses = [
    "repairing",
    "waiting-for-choice",
    "needs-person",
];
const actions = [
    "retry",
    "wait",
    "advice",
    "agent",
    "rerun",
    "amend",
    "options",
];
/**
 * The digest that ties a repair record to one `pending` comment: the first 16 hex
 * characters of the SHA-256 of its exact body (UTF-8, as the API returns `body`,
 * marker line included).
 */
function pendingDigest(body) {
    return createHash("sha256").update(body, "utf8").digest("hex").slice(0, 16);
}
const stateLine = new RegExp("^<!-- nibfin:repair-state for=([0-9a-f]{16}) status=([a-z-]+) action=([a-z]+) " +
    "handled=([A-Z0-9_,]*)(?: reset=([0-9T:.Z-]+))? -->$");
/**
 * The state of a repair record from its comment body: the first line after the
 * `repair` marker (or the first line when there is no marker). A missing or
 * unparseable state line, or `action=wait` without `reset`, is no record.
 */
function parseRepairRecord(body) {
    const lines = body.split("\n");
    const first = lines[0] === "<!-- nibfin:repair -->" ? lines[1] : lines[0];
    const match = stateLine.exec(first ?? "");
    if (match === null) {
        return undefined;
    }
    const [, digest, status, action, handled, reset] = match;
    if (!statuses.includes(status) ||
        !actions.includes(action) ||
        (action === "wait" && reset === undefined)) {
        return undefined;
    }
    return {
        for: digest,
        status: status,
        action: action,
        handled: handled === "" ? [] : handled.split(",").filter((code) => code !== ""),
        ...(reset === undefined ? {} : { reset }),
    };
}
/** Whether a comment changed at `updatedAt` came after `pending` was last removed. */
function changedSince(updatedAt, lastUnlabeledPendingAt) {
    return (lastUnlabeledPendingAt === null ||
        Date.parse(updatedAt) > Date.parse(lastUnlabeledPendingAt));
}
/**
 * Whether the cause comment belongs to the current `pending` label: it exists and
 * changed after `pending` was last removed (or `pending` never was).
 */
function isPendingCurrent(input) {
    const { pendingComment, lastUnlabeledPendingAt } = input;
    return (pendingComment !== null &&
        changedSince(pendingComment.updatedAt, lastUnlabeledPendingAt));
}
/**
 * The comment that explains the current `pending` stop, from Nibfin's marked `pending`
 * and `scope-request` comments (either may be absent): of those changed after
 * `pending` was last removed (any, when it never was), the one changed last; on a tie
 * the `pending` comment, since every flow writes it after a Scope comment for the same
 * stop. `null` when none is current, so an old cause never explains a new stop.
 */
function currentCause(candidates, lastUnlabeledPendingAt) {
    let best = null;
    for (const candidate of candidates) {
        if (candidate == null || !changedSince(candidate.updatedAt, lastUnlabeledPendingAt)) {
            continue;
        }
        const delta = best === null ? 1 : Date.parse(candidate.updatedAt) - Date.parse(best.updatedAt);
        if (delta > 0 || (delta === 0 && candidate.key === pendingCommentKey)) {
            best = candidate;
        }
    }
    return best;
}
/** Whether the record covers the current cause comment. */
function recordApplies(input) {
    return (input.hasPendingLabel &&
        isPendingCurrent(input) &&
        input.record != null &&
        input.record.for === pendingDigest(input.pendingComment.body));
}

function unconfirmed(operation, reason) {
    return new GitHubError("GITHUB_WRITE_UNCONFIRMED", operation, new Error(reason));
}

/** Failures that usually pass on their own: network, GitHub or a single agent run. */
const temporaryCodes = new Set([
    "GITHUB_READ_FAILED",
    "GITHUB_WRITE_UNCONFIRMED",
    "STAGE_GIT_FAILED",
    "TOOL_INSTALL_FAILED",
    "AGENT_RUN_FAILED",
    "STAGE_RESULT_INVALID",
]);
/** Another Writer is running; its own post-stage route continues the Issue. */
const waitCode = "STAGE_WRITER_ACTIVE";
/** GitHub answered and refused a write, e.g. a body it will not take. */
const rejectedCode = "GITHUB_WRITE_REJECTED";
/** The provider's usage limit stopped the agent; it is not over before the reset. */
const usageLimitCode = "AGENT_USAGE_LIMIT";
/** The code of a failure, if it carries one. */
function codeOf(error) {
    if (typeof error !== "object" || error === null || !("code" in error)) {
        return undefined;
    }
    return typeof error.code === "string" ? error.code : undefined;
}
/** A failure as its code, if any, and its message, as the Job log shows it. */
function describeFailure(error) {
    if (!(error instanceof Error)) {
        return String(error);
    }
    const { code } = error;
    return typeof code === "string" ? `${code}: ${error.message}` : error.message;
}
/** Whether `error` is the wait for another Writer, which writes nothing. */
function isWait(error) {
    return codeOf(error) === waitCode;
}
/** The URL of a workflow run, from the execution repository and run id. */
function runUrl(repo, id) {
    return repo === undefined || id === undefined
        ? undefined
        : `https://github.com/${repo.owner}/${repo.repo}/actions/runs/${id}`;
}
/**
 * The sentence a `pending` comment carries for a failure that looks temporary. Only
 * `pendingBody` writes it (a failed wake too, #776); the repair stage reads it.
 */
const temporarySentence = "This looks temporary (network, GitHub or a single agent run); removing the " +
    "label retries it.";
/** The start of the usage-limit note; `it resets at` follows when the CLI said so. */
const usageLimitLead = "The provider's usage limit was reached;";
/** When to remove `pending` after a usage-limit stop, outside the fenced message. */
function usageLimitNote(reset) {
    return reset === undefined
        ? `${usageLimitLead} the CLI did not report when it ` +
            "resets. Remove the `pending` label after the limit resets to continue."
        : `${usageLimitLead} it resets at \`${reset}\`. Remove ` +
            "the `pending` label after that time to continue.";
}
/**
 * Reads a `pending` comment body. Only Core's own lines count: the header before the
 * first ```` ```text ```` line and the trailer after the last ```` ``` ```` line (the
 * whole body when there is no fence), so a failure message inside the fence cannot
 * fake a code, the temporary sentence or a reset time.
 */
function readPendingCause(body) {
    const lines = body.split("\n");
    const open = lines.indexOf("```text");
    const close = lines.lastIndexOf("```");
    const fenced = open !== -1 && close > open;
    const header = fenced ? lines.slice(0, open) : lines;
    const trailer = fenced ? lines.slice(close + 1) : lines;
    const code = header
        .map((line) => /^- Code: `([A-Z0-9_]+)`$/.exec(line)?.[1])
        .find((value) => value !== undefined);
    const reset = trailer
        .filter((line) => line.startsWith(usageLimitLead))
        .map((line) => /it resets at `([^`]+)`/.exec(line)?.[1])
        .find((value) => value !== undefined);
    const run = header
        .map((line) => /^- Run: (https:\/\/\S+)$/.exec(line)?.[1])
        .find((value) => value !== undefined);
    return {
        code,
        run,
        temporary: trailer.includes(temporarySentence),
        reset,
        fromRepair: header.includes("- Stage: `repair`"),
    };
}
const stopLead = "<!-- nibfin:stop at=";
/**
 * The hidden stop line Core writes right after the marker of a cause comment: when it
 * was written (so every write for a new stop changes the body and its `updated_at`)
 * and, with `facts`, the stop's code, run, temporary flag and reset. Values are
 * URI-encoded, so they hold no space and no `-->`.
 */
function stopLine(at, facts) {
    const parts = [`${stopLead}${at.toISOString()}`];
    return `${parts.join(" ")} -->`;
}
function decoded(value) {
    if (value === undefined) {
        return undefined;
    }
    try {
        return decodeURIComponent(value);
    }
    catch {
        return undefined;
    }
}
/** The facts of a stop line as `stopLine` writes it; `undefined` for any other line. */
function parseStopLine(line) {
    const match = /^<!-- nibfin:stop at=\S+((?: [a-z]+=\S+)*) -->$/.exec(line);
    if (match === null) {
        return undefined;
    }
    const fields = new Map(match[1]
        .split(" ")
        .filter((part) => part !== "")
        .map((part) => {
        const split = part.indexOf("=");
        return [part.slice(0, split), part.slice(split + 1)];
    }));
    const code = fields.get("code");
    return {
        code: code !== undefined && /^[A-Z0-9_]+$/.test(code) ? code : undefined,
        run: decoded(fields.get("run")),
        temporary: fields.get("temporary") === "true",
        reset: decoded(fields.get("reset")),
    };
}
/**
 * What Core's own lines of a cause comment say. A `pending` comment is read by
 * `readPendingCause`. A `scope-request` comment also holds the Scope agent's reason
 * and request text, so only its first two lines count: the exact marker, then a stop
 * line, whose facts it returns (a failed write's code, run, temporary flag and reset).
 * Anything from line 3 on is never read, and a comment without that stop line (one
 * written before Core wrote it) has no code. A Scope comment never names the repair
 * stage.
 */
function readCause(comment) {
    if (comment.key !== scopeRequestCommentKey) {
        return readPendingCause(comment.body);
    }
    const [marker, line = ""] = comment.body.split("\n");
    const facts = marker === commentMarker(scopeRequestCommentKey) ? parseStopLine(line) : undefined;
    return {
        code: facts?.code,
        run: facts?.run,
        temporary: facts?.temporary ?? false,
        reset: facts?.reset,
        fromRepair: false,
    };
}
function isTemporary(error, code) {
    if (error instanceof NoProgressError) {
        return error.temporary;
    }
    if (error instanceof GitHubError && rateLimitOf(error.cause) !== undefined) {
        return true;
    }
    return code !== undefined && temporaryCodes.has(code);
}
/**
 * The facts `pendingBody` states for `error` in run `url`: its code, the run, whether
 * it looks temporary and, for a usage limit only, the reset the CLI reported.
 */
function pendingCauseOf(error, url) {
    const code = codeOf(error);
    const reset = code === usageLimitCode && error instanceof AgentError
        ? error.usageLimitReset
        : undefined;
    return { code, run: url, temporary: isTemporary(error, code), reset };
}
/**
 * The `pending` comment body for `error`. Without `withMessage` the fenced message
 * block is replaced by a pointer to the run log, where the full message always goes.
 */
function pendingBody(error, url, withMessage = true, stage) {
    const { code, temporary, reset } = pendingCauseOf(error, url);
    const message = error instanceof Error ? error.message : String(error);
    const lines = [
        "Nibfin stopped and needs a person.",
        "",
        `- Code: \`${code ?? "none"}\``,
        `- Run: ${url ?? "unknown"}`,
        ...(stage === undefined ? [] : [`- Stage: \`${stage}\``]),
        "",
        ...(withMessage
            ? ["```text", message, "```"]
            : ["The full message is in the run log."]),
        "",
    ];
    if (code === usageLimitCode) {
        lines.push(usageLimitNote(reset), "");
    }
    if (temporary) {
        lines.push(temporarySentence, "");
    }
    lines.push("Remove the `pending` label to continue.");
    return lines.join("\n");
}
/**
 * Upserts the marked comment `key` on `issue` with `render(true)`. When GitHub
 * rejects it (`GITHUB_WRITE_REJECTED`, e.g. a very long message), it writes
 * `render(false)`, the body without the message, once more. Any other failure is
 * thrown.
 */
async function upsertPersonComment(client, issue, key, render) {
    try {
        return await upsertMarkedComment(client, issue, key, render(true));
    }
    catch (failure) {
        if (codeOf(failure) !== rejectedCode) {
            throw failure;
        }
        return upsertMarkedComment(client, issue, key, render(false));
    }
}
/**
 * Upserts the cause comment `key` of a new stop on `issue`: a fresh stop line (`stopLine`
 * at `now()`, with `facts` when given) right after the marker, then `render`'s text,
 * through `upsertPersonComment` (both bodies share the stop line). The stop line makes
 * every write for a new stop change the body, even when the text is the same as before,
 * so its `updated_at` moves past the last removal of `pending`.
 */
async function upsertCauseComment(client, issue, key, render, facts, now = () => new Date()) {
    const line = stopLine(now());
    return upsertPersonComment(client, issue, key, (withMessage) => `${line}\n${render(withMessage)}`);
}
/**
 * Asks a person to act on `issue` after `error`: upserts the marked `pending`
 * comment and adds `pending`, confirmed by the read-back labels. Nothing runs for
 * the Issue while `pending` is present; removing it is the go-ahead. A
 * `STAGE_WRITER_ACTIVE` error is a wait, not a failure, and writes nothing. When
 * GitHub rejects the comment (`GITHUB_WRITE_REJECTED`, e.g. a very long message), it
 * writes it once more without the message, then adds the label as usual. With
 * `stage` the comment names the stage that failed (`- Stage:`); the repair stage
 * passes `repair`, so it does not start again for that stop (Proposal R4.50).
 * Returns whether it wrote.
 */
async function requestPerson(client, issue, error, url, stage) {
    if (isWait(error)) {
        return false;
    }
    await upsertCauseComment(client, issue, pendingCommentKey, (withMessage) => pendingBody(error, url, withMessage, stage));
    await addPendingLabel(client, issue);
    return true;
}
/** Adds `pending`, confirmed by the read-back labels. */
async function addPendingLabel(client, issue) {
    const labels = await setLabels(client, issue, { add: [nibfinLabels.pending] });
    if (!labels.includes(nibfinLabels.pending)) {
        throw unconfirmed("add pending", "The read-back labels lack pending");
    }
}
/** Nibfin's marked comment `key` on `issue` by REST (for `updated_at`), if any. */
async function readCauseComment(client, issue, key) {
    const marked = await findMarkedComment(client, issue, key);
    return marked === undefined
        ? null
        : { ...(await readIssueComment(client, issue, marked.id)), key };
}
/**
 * Reads the reader rule's inputs for `issue`: Nibfin's marked `pending` and
 * `scope-request` comments (by REST, for `updated_at`), when `pending` was last
 * removed, and Nibfin's marked `repair` comment, parsed. `pendingComment` is the one
 * `currentCause` picks, or the `pending` comment (not current) when neither is.
 * `hasPendingLabel` is passed through as the caller read it.
 */
async function readRepairInput(client, issue, hasPendingLabel) {
    const pending = await readCauseComment(client, issue, pendingCommentKey);
    const scope = await readCauseComment(client, issue, scopeRequestCommentKey);
    const lastUnlabeled = await readLastUnlabeled(client, issue, nibfinLabels.pending);
    const repair = await findMarkedComment(client, issue, repairCommentKey);
    const record = repair === undefined ? null : (parseRepairRecord(repair.body) ?? null);
    return {
        hasPendingLabel,
        pendingComment: currentCause([pending, scope], lastUnlabeled) ?? pending,
        lastUnlabeledPendingAt: lastUnlabeled,
        record,
    };
}
/**
 * A Job that failed before Core could report a cause (#776): the workflow's last step
 * writes it. Not temporary, so the repair stage hands it to the repair agent.
 */
class JobFailedError extends Error {
    code = "JOB_FAILED";
    stage;
    amendment;
    /** With `amendment`, the message adds that the repair's amendment may be partial. */
    constructor(stage, amendment = false) {
        const note = amendment ? ` ${amendmentNote}` : "";
        super(`The \`${stage}\` Job failed before Nibfin could report a cause (checkout, ` +
            `image pull, container start or clean up); see the run log.${note}`);
        this.name = "JobFailedError";
        this.stage = stage;
        this.amendment = amendment;
    }
}
/** The repair actions whose Job is still doing its step (the route resumes both). */
const repairInProgress = new Set(["agent", "amend"]);
/**
 * Asks a person once after a failure that Core may already have reported (#776): the
 * failed Job's last step (`stage` is the Job's stage) and a failed wake (no `stage`).
 * The labels are read first.
 *
 * 1. Not `repair` and `pending` is there: nothing; the standing stop's comment stays.
 *    For `repair` it goes on only while Nibfin's repair record covers the current
 *    cause comment as `repairing` `agent` or `amend` (the repair has not done its
 *    step); otherwise nothing, so a late failure never undoes the repair's result.
 * 2. The current cause comment (`currentCause`) names this run (`readCause`; a Scope
 *    comment only after a failed write): only `pending` is added, so Core's specific
 *    cause is never overwritten.
 * 3. Otherwise `requestPerson`, naming the repair stage for `repair`. Under an `amend`
 *    record a `JobFailedError` adds that the amendment may be partly applied.
 *
 * Returns whether it wrote.
 */
async function askPersonOnce(client, issue, error, url, stage) {
    const { labels } = await readIssueRecord(client, issue);
    const hasPendingLabel = labels.includes(nibfinLabels.pending);
    const repair = stage === "repair";
    // Any other Job only acts without `pending`; a repair Job only with it.
    if (hasPendingLabel !== repair) {
        return false;
    }
    const input = await readRepairInput(client, issue, hasPendingLabel);
    let failure = error;
    if (repair) {
        const { record } = input;
        if (!recordApplies(input) ||
            record.status !== "repairing" ||
            !repairInProgress.has(record.action)) {
            return false;
        }
        if (record.action === "amend" && error instanceof JobFailedError) {
            failure = new JobFailedError(error.stage, true);
        }
    }
    const comment = input.pendingComment;
    if (url !== undefined &&
        comment !== null &&
        isPendingCurrent(input) &&
        readCause(comment).run === url) {
        await addPendingLabel(client, issue);
        return true;
    }
    return requestPerson(client, issue, failure, url, repair ? "repair" : undefined);
}

/** The execution repository's workflow that runs every route and stage Job. */
const sharedRunnerWorkflow = "nibfin-shared-runner.yml";
const repoName = (repo) => `${repo.owner}/${repo.repo}`;
async function dispatch(scope, title, inputs) {
    const url = await dispatchWorkflow(scope.client, scope.runRepo, sharedRunnerWorkflow, inputs);
    scope.log(`Dispatched ${title}${url === undefined ? "" : `: ${url}`}`);
}
/**
 * Dispatches a route run for the target; never deduplicated, so no wake is lost. An
 * Issue is sent as `issue`; a commit as `sha` and a branch as `branch`, each also as
 * `ref`, which names the run `Nibfin · <owner>/<repo>@<ref> · route` as the shared
 * runner does.
 */
async function dispatchRoute(scope, repo, target) {
    const inputs = { stage: "route", repo: repoName(repo) };
    if ("issue" in target) {
        const title = nibfinRunTitle(repo, target.issue, "route");
        await dispatch(scope, title, { ...inputs, issue: String(target.issue) });
        return;
    }
    const [name, ref] = "sha" in target ? ["sha", target.sha] : ["branch", target.branch];
    const title = `${nibfinWorkflowPrefix} ${repoName(repo)}@${ref} · route`;
    await dispatch(scope, title, { ...inputs, [name]: ref, ref });
}

// The Issues an event names (#776: kept apart from `route.ts`, which reaches the
// stages barrel, so the Action can import it).
/**
 * The Issues of an event target, without repeats: the Issue itself; the Issue of a
 * `nibfin/issue-<n>[-cd-<k>]` branch; or for a commit, the Issues of every open or
 * merged pull request of `GET /commits/{sha}/pulls` whose head is such a branch,
 * then those of every merged pull request whose `merge_commit_sha` is the commit
 * (a pull request that merged without moving the base is not associated with it,
 * #771). Empty when the target belongs to no Issue.
 */
async function routeEvent(client, repo, target) {
    if ("issue" in target) {
        return [target.issue];
    }
    if ("branch" in target) {
        const issue = issueOfBranch(target.branch);
        return issue === undefined ? [] : [issue];
    }
    return issuesOfCommit(client, repo, target.sha);
}

const issueBranchPrefix = "nibfin/issue-";
/** Labels Nibfin's own stages add and remove; their changes wake nothing. */
const ownLabels = new Set(["shaped", "delivered"]);
function invalidEvent(eventName, field) {
    return new StageError("STAGE_INPUT_INVALID", `The ${eventName} event has no ${field}`);
}
/** The execution repository, required before any target or token is used. */
function executionRepoOf(value) {
    if (value === undefined || value.trim() === "") {
        throw new StageError("STAGE_INPUT_INVALID", "The variable NIBFIN_EXECUTION_REPO is not set (input execution-repo)");
    }
    return readRepo(value, "NIBFIN_EXECUTION_REPO");
}
const skip = (reason) => ({ kind: "skip", reason });
function issuesWake(payload, name, executionRepo) {
    const number = payload.issue?.number;
    if (number === undefined) {
        throw invalidEvent("issues", "issue");
    }
    const labels = (payload.issue?.labels ?? []).map((label) => label.name);
    if (!labels.includes("scope") && !labels.includes("request")) {
        return skip(`${name}#${number} has no scope or request label; not routed`);
    }
    const { action } = payload;
    const label = payload.label?.name;
    if ((action === "labeled" || action === "unlabeled") &&
        label !== undefined &&
        ownLabels.has(label)) {
        return skip(`Nibfin's own label change (${action} ${label}); not routed`);
    }
    const writer = payload.sender?.login;
    if (writer === undefined) {
        throw invalidEvent("issues", "sender");
    }
    const target = { issue: number };
    return { kind: "wake", executionRepo, target, writer };
}
function reviewWake(payload, name, executionRepo) {
    const head = payload.pull_request?.head;
    const branch = head?.ref;
    if (branch === undefined || !branch.startsWith(issueBranchPrefix)) {
        return skip("A review on a pull request that is not Nibfin's; not routed");
    }
    const headRepo = head?.repo?.full_name;
    if (headRepo !== name) {
        const from = headRepo ?? "an unknown repository";
        return skip(`A review on a pull request from ${from}; not routed`);
    }
    const repo = executionRepoOf(executionRepo);
    const writer = payload.sender?.login;
    if (writer === undefined) {
        throw invalidEvent("pull_request_review", "sender");
    }
    return { kind: "wake", executionRepo: repo, target: { branch }, writer };
}
function workflowRunTarget(payload, name) {
    const run = payload.workflow_run;
    if (run?.event === "pull_request") {
        const branch = run.head_branch;
        if (typeof branch !== "string" || !branch.startsWith(issueBranchPrefix)) {
            return "A run of a pull request that is not Nibfin's; not routed";
        }
        const headRepo = run.head_repository?.full_name;
        if (headRepo !== name) {
            return `A pull request from ${headRepo ?? "an unknown repository"}; not routed`;
        }
        return { branch };
    }
    const sha = run?.head_sha;
    if (sha === undefined) {
        throw invalidEvent("workflow_run", "head_sha");
    }
    return { sha };
}
function checkSuiteTarget(payload) {
    const suite = payload.check_suite;
    const branch = suite?.head_branch;
    if (suite?.app?.slug === "github-actions" || typeof branch !== "string" || !branch) {
        return "A check suite of GitHub Actions or of no branch; not routed";
    }
    return { branch };
}
function pushTarget(payload) {
    const branch = payload.repository?.default_branch;
    if (branch === undefined || payload.ref !== `refs/heads/${branch}`) {
        return "A push to a branch that is not the default branch; not routed";
    }
    if (payload.after === undefined) {
        throw invalidEvent("push", "after");
    }
    return { sha: payload.after };
}
/** The target of an event that wakes without a permission check, or why it skips. */
function targetOf(eventName, payload, name) {
    switch (eventName) {
        case "workflow_run":
            return workflowRunTarget(payload, name);
        case "check_suite":
            return checkSuiteTarget(payload);
        case "status":
            if (payload.sha === undefined) {
                throw invalidEvent("status", "sha");
            }
            return { sha: payload.sha };
        case "push":
            return pushTarget(payload);
        default:
            return `The ${eventName} event is not routed`;
    }
}
/**
 * What an event of `repo` wakes, decided from its payload alone, before any token is
 * used, with the workflows' rules in their order (#776):
 *
 * - every event but `pull_request_review` first needs the execution repository;
 * - `issues`: the Issue needs `scope` or `request`, and a `labeled` or `unlabeled`
 *   `shaped` or `delivered` wakes nothing; then `{ issue }`, if the sender writes;
 * - `pull_request_review`: a `nibfin/issue-*` head of the same repository, then the
 *   execution repository; `{ branch }`, if the sender writes;
 * - `workflow_run`: of a `pull_request`, a `nibfin/issue-*` head of the same
 *   repository, `{ branch }` (a failed check is never routed by commit); any other,
 *   `{ sha: head_sha }`;
 * - `check_suite`: not of the `github-actions` app and with a head branch,
 *   `{ branch }`;
 * - `status`: `{ sha }`; `push`: only to the default branch, `{ sha: after }`;
 * - any other event is not routed.
 *
 * A missing or invalid `NIBFIN_EXECUTION_REPO`, or a payload without a field its event
 * always has, is `STAGE_INPUT_INVALID`.
 */
function wakeOf(eventName, payload, repo, executionRepo) {
    const name = `${repo.owner}/${repo.repo}`;
    if (eventName === "pull_request_review") {
        return reviewWake(payload, name, executionRepo);
    }
    const execution = executionRepoOf(executionRepo);
    if (eventName === "issues") {
        return issuesWake(payload, name, execution);
    }
    const target = targetOf(eventName, payload, name);
    return typeof target === "string"
        ? skip(target)
        : { kind: "wake", executionRepo: execution, target, writer: undefined };
}
/**
 * After a failed wake, asks a person once on each Issue of the target (`routeEvent`)
 * with the failure itself (`askPersonOnce`): an Issue whose `pending` stands is left
 * as it is. Nothing is written when the target belongs to no Issue or its Issues
 * cannot be read.
 */
async function askPeople(client, input, target, error, log) {
    let issues;
    try {
        issues = await routeEvent(client, input.repo, target);
    }
    catch (readError) {
        const reason = describeFailure(readError);
        log(`The wake failed and its Issues could not be read (${reason}); no pending added`);
        return;
    }
    if (issues.length === 0) {
        log("The wake failed and belongs to no Issue; no pending added");
    }
    for (const number of issues) {
        const issue = { ...input.repo, number };
        const name = formatIssue(issue);
        try {
            const wrote = await askPersonOnce(client, issue, error, input.url);
            log(wrote
                ? `Added pending to ${name}`
                : `${name}: Nibfin's stop stands; left as it is`);
        }
        catch (writeError) {
            log(`Could not add pending to ${name}: ${describeFailure(writeError)}`);
        }
    }
}
/**
 * Wakes the event's Issue (`wakeOf`): a skipped event logs why and never connects.
 * Otherwise it connects, checks the writer's permission (`hasWritePermission`; without
 * it nothing is routed) and dispatches the route run (`dispatchRoute`). When that
 * fails, each Issue of the target is asked about once (`askPersonOnce`) and the failure
 * is thrown on, so the run fails.
 */
async function runWake(input, connect, log) {
    const decision = wakeOf(input.eventName, input.payload, input.repo, input.executionRepo);
    if (decision.kind === "skip") {
        log(decision.reason);
        return;
    }
    const client = await connect();
    const { target, writer } = decision;
    try {
        if (writer !== undefined && !(await hasWritePermission(client, input.repo, writer))) {
            log(`${writer} has no admin or write permission; not routed`);
            return;
        }
        const scope = { client, runRepo: decision.executionRepo, runId: undefined, log };
        await dispatchRoute(scope, input.repo, target);
    }
    catch (error) {
        await askPeople(client, input, target, error, log);
        throw error;
    }
}

// `age` for a runner request (#776): the registration token is encrypted to the
// requester's SSH key. `age` runs with only `PATH` in its environment, so no token
// of the Action's own environment (`INPUT_*`) reaches it (R3.49).
/** `age` could not run, or failed; the message never carries its input or output. */
class AgeError extends Error {
    code = "RUNNER_AGE_FAILED";
    constructor(what, reason) {
        super(`${what} failed (${reason})`);
        this.name = "AgeError";
    }
}
/** The only variable `age` gets. */
function ageEnv(env) {
    return env.PATH === undefined ? {} : { PATH: env.PATH };
}
async function exitOf(what, run) {
    let status;
    try {
        status = await run();
    }
    catch (error) {
        // A process that did not start: Node's error code, such as ENOENT.
        throw new AgeError(what, String(error.code));
    }
    if (status.exitCode !== 0) {
        throw new AgeError(what, describeExit(status));
    }
}
/**
 * `age` as `command` runs it (`age` from `PATH` by default), with only `PATH` from
 * `env`. `encrypt` runs `age -a -R <file>` with the recipient in a file of a fresh
 * temporary directory, removed afterwards, and the plaintext on stdin.
 */
function createAge(env, command = { command: "age", args: [] }) {
    const request = { command, cwd: tmpdir(), env: ageEnv(env) };
    return {
        check: () => exitOf("age --version", () => runQuiet({ ...request, args: ["--version"] })),
        async encrypt(recipient, plaintext) {
            const dir = await mkdtemp(join(tmpdir(), "nibfin-age-"));
            try {
                const file = join(dir, "recipient.pub");
                await writeFile(file, `${recipient}\n`);
                let stdout = "";
                await exitOf("age -a -R", () => runStreaming({
                    ...request,
                    args: ["-a", "-R", file],
                    stdin: plaintext,
                    stdout: { write: (chunk) => (stdout += Buffer.from(chunk).toString()) },
                    stderr: { write: () => undefined },
                    onLine: () => undefined,
                }));
                return stdout;
            }
            finally {
                await rm(dir, { recursive: true, force: true });
            }
        },
    };
}

/** Whether the Issue is `open` or `closed`, read with REST `GET`. */
async function readIssueState(client, issue) {
    const { data } = await read(`read the state of ${formatIssue(issue)}`, () => client.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
        owner: issue.owner,
        repo: issue.repo,
        issue_number: issue.number,
    }));
    return data.state;
}
/**
 * Closes the Issue as not planned with REST `PATCH` through `write()`. Its confirm
 * drops the kept reads (`freshReads`) and reads the state again, so a close that took
 * effect is not sent again; an Issue already closed is left as it is.
 */
async function closeIssueNotPlanned(client, issue) {
    const closed = async () => {
        freshReads(client);
        return (await readIssueState(client, issue)) === "closed" ? true : undefined;
    };
    if (await closed()) {
        return;
    }
    await write(client, `close ${formatIssue(issue)} as not planned`, async () => {
        await client.request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", {
            owner: issue.owner,
            repo: issue.repo,
            issue_number: issue.number,
            state: "closed",
            state_reason: "not_planned",
        });
        return true;
    }, { confirm: closed });
}

/** The public SSH keys of the account `login`, all pages (`GET /users/{login}/keys`). */
async function readUserKeys(client, login) {
    const keys = await read(`list the SSH keys of ${login}`, () => client.paginate("GET /users/{username}/keys", { username: login, per_page: 100 }));
    return keys.map(({ id, key }) => ({ id, key }));
}
/** The base64 part of a public key `<type> <base64> [comment]`. */
function keyBlob(key) {
    return key.split(" ")[1];
}
/** The deploy key of `repo` whose key blob equals the blob of `key`, all pages. */
async function findDeployKey(client, repo, key) {
    const blob = keyBlob(key);
    const keys = await read(`list the deploy keys of ${repo.owner}/${repo.repo}`, () => client.paginate("GET /repos/{owner}/{repo}/keys", { ...repo, per_page: 100 }));
    const found = keys.find((candidate) => keyBlob(candidate.key) === blob);
    return found === undefined ? undefined : { id: found.id, readOnly: found.read_only };
}
/**
 * Adds `key` as a read-only deploy key titled `title` to `repo` through `write()`.
 * Its confirm lists the deploy keys and matches the key blob, so a key that is
 * already a deploy key of `repo`, also one an earlier attempt added, is success.
 * Returns the deploy key and whether this call added it.
 */
async function addDeployKey(client, repo, title, key) {
    return write(client, `add a deploy key to ${repo.owner}/${repo.repo}`, async () => {
        const { data } = await client.request("POST /repos/{owner}/{repo}/keys", {
            ...repo,
            title,
            key,
            read_only: true,
        });
        return { id: data.id, readOnly: data.read_only, added: true };
    }, {
        confirm: async () => {
            const found = await findDeployKey(client, repo, key);
            return found === undefined ? undefined : { ...found, added: false };
        },
    });
}
/**
 * Creates a runner registration token for `repo`
 * (`POST /repos/{owner}/{repo}/actions/runners/registration-token`). A token cannot
 * be confirmed by a re-read and a new one per send is harmless (each expires unused),
 * so any failure is re-sent without a pre-read up to `maxRetries` times.
 */
async function createRegistrationToken(client, repo) {
    return write(client, `create a runner registration token for ${repo.owner}/${repo.repo}`, async () => {
        const { data } = await client.request("POST /repos/{owner}/{repo}/actions/runners/registration-token", { ...repo });
        return { token: data.token, expiresAt: data.expires_at };
    }, { confirm: () => Promise.resolve(undefined) });
}

/** The comment key of a registration token answer. */
const registrationKey = "runner-registration";
/** The comment key of a refusal, also of a failed request. */
const refusedKey = "runner-request-refused";
/** The body of a refusal: its reason and what the requester does next. */
function refusalBody(refusal) {
    return `reason: ${refusal.reason}\n\n${refusal.next}\n`;
}
/** The refusal of a request whose workflow failed, naming the run. */
function failedRefusal(url) {
    return {
        reason: `the request workflow failed (${url ?? "unknown"})`,
        next: "Read the run's log; run gh nibfin runner add again when the cause is fixed.",
    };
}
/** The body of a registration answer. */
function registrationBody(repo, registration) {
    const { login, keyId, expiresAt, ciphertext } = registration;
    return [
        `requester: ${login}`,
        `ssh-key-id: ${keyId}`,
        `expires-at: ${expiresAt}`,
        "",
        `A runner registration token for ${repo.owner}/${repo.repo}, encrypted to the ` +
            `SSH key ${keyId} of @${login}. gh nibfin runner add decrypts it and registers ` +
            "the runner.",
        "",
        "```text",
        ciphertext.replace(/\n+$/, ""),
        "```",
        "",
    ].join("\n");
}

/** The line every runner request body carries; the workflow's job filters on it. */
const requestMarker = "<!-- nibfin:runner-request -->";
/** The title gh-nibfin's `runner add` gives a request. */
const requestTitle = "Nibfin runner request";
const openAgain = "Open the request with gh nibfin runner add.";
const keyIdLine = /^ssh-key-id: ([1-9][0-9]{0,18})$/;
const deployKeyLine = /^deploy-key: ssh-ed25519 ([A-Za-z0-9+/]+={0,2})$/;
/** The wire format of an ssh-ed25519 public key: length 11, the name, length 32. */
const ed25519Prefix = Buffer.from("0000000b7373682d6564323535313900000020", "hex");
const ed25519Length = ed25519Prefix.length + 32;
const refused = (reason, next = openAgain) => ({
    kind: "refused",
    refusal: { reason, next },
});
/** Whether `blob` is the base64 of an ssh-ed25519 public key, down to its bytes. */
function isEd25519(blob) {
    if (blob.length % 4 !== 0) {
        return false;
    }
    const bytes = Buffer.from(blob, "base64");
    return (bytes.length === ed25519Length &&
        bytes.subarray(0, ed25519Prefix.length).equals(ed25519Prefix));
}
/**
 * Checks a request as the event gave it, in this order: the title, an author of type
 * `User`, exactly one `ssh-key-id: <id>` line (`<id>` is `[1-9][0-9]{0,18}`), and at
 * most one `deploy-key: ssh-ed25519 <base64>` line whose key decodes to the
 * ssh-ed25519 wire format. Carriage returns are removed first.
 */
function checkRequest(issue, repo) {
    if (issue.title !== requestTitle) {
        return refused(`the title is not "${requestTitle}"`);
    }
    if (issue.userType !== "User") {
        return refused(`the author ${issue.login} is a ${issue.userType} account, not a user`, `A user with write access to ${repo.owner}/${repo.repo} opens the request ` +
            "with gh nibfin runner add.");
    }
    const lines = issue.body.replaceAll("\r", "").split("\n");
    const keyLines = lines.filter((line) => line.startsWith("ssh-key-id:"));
    if (keyLines.length !== 1) {
        return refused(`the body has ${keyLines.length} ssh-key-id lines, want exactly one`);
    }
    const keyId = keyIdLine.exec(keyLines[0])?.[1];
    if (keyId === undefined) {
        return refused('the ssh-key-id line is not "ssh-key-id: <id>"');
    }
    const deployLines = lines.filter((line) => line.startsWith("deploy-key:"));
    if (deployLines.length > 1) {
        return refused(`the body has ${deployLines.length} deploy-key lines, want at most one`);
    }
    if (deployLines.length === 0) {
        return { kind: "ok", keyId, deployKey: undefined };
    }
    const blob = deployKeyLine.exec(deployLines[0])?.[1];
    if (blob === undefined || !isEd25519(blob)) {
        return refused("the deploy-key line is not an ssh-ed25519 public key");
    }
    return { kind: "ok", keyId, deployKey: `ssh-ed25519 ${blob}` };
}
/** The refusal for an author without write or admin permission. */
function permissionRefusal(login, permission, repo) {
    const name = `${repo.owner}/${repo.repo}`;
    return {
        reason: `${login} has ${permission} permission on ${name}, not write or admin`,
        next: `Ask the owner of ${name} to make you a collaborator with write access, then ` +
            "run gh nibfin runner add again.",
    };
}
/** The type of a public key `<type> <base64>`: the text before the first space. */
function keyType(key) {
    return key.split(" ")[0];
}
/**
 * Checks the SSH key the request names, `undefined` when the account has no key with
 * that id: only ssh-ed25519 and ssh-rsa keys are taken. Returns the refusal, if any.
 */
function checkKey(login, keyId, key) {
    if (key === undefined || key === "") {
        return {
            reason: `${login} has no SSH key with id ${keyId} on GitHub`,
            next: "Add the SSH key to your GitHub account, then run gh nibfin runner add " +
                "again.",
        };
    }
    if (!key.startsWith("ssh-ed25519 ") && !key.startsWith("ssh-rsa ")) {
        return {
            reason: `the SSH key ${keyId} of ${login} is ${keyType(key)}, ` +
                "not ssh-ed25519 or ssh-rsa",
            next: "Use an ssh-ed25519 or ssh-rsa key of your GitHub account with " +
                "gh nibfin runner add.",
        };
    }
    return undefined;
}

/** The answer of a request that passed the body checks, or why it is refused. */
async function prepare(input, deps, checked) {
    const { repo, issue } = input;
    const { login } = issue;
    const { keyId, deployKey } = checked;
    const name = `${repo.owner}/${repo.repo}`;
    const nibfin = await deps.connect();
    const permission = await readCollaboratorPermission(nibfin, repo, login);
    if (!isWritePermission(permission)) {
        return { kind: "refused", refusal: permissionRefusal(login, permission, repo) };
    }
    const keys = await readUserKeys(deps.job, login);
    const key = keys.find((candidate) => String(candidate.id) === keyId)?.key;
    const keyRefusal = checkKey(login, keyId, key);
    if (keyRefusal !== undefined) {
        return { kind: "refused", refusal: keyRefusal };
    }
    deps.log(`Request of ${login} for the SSH key ${keyId} (${keyType(key)})`);
    // Before any write: without age no deploy key or token is created.
    await deps.age.check();
    if (deployKey !== undefined) {
        const title = `nibfin-runner-${login}`;
        deps.log("The request has a deploy key");
        const added = await addDeployKey(nibfin, repo, title, deployKey);
        deps.log(added.added
            ? `Added the read-only deploy key ${title} to ${name} (id ${added.id})`
            : `The key is already a deploy key of ${name} ` +
                `(id ${added.id}, read_only ${added.readOnly})`);
    }
    const token = await createRegistrationToken(nibfin, repo);
    if (!token.token) {
        throw new Error("GitHub returned no registration token");
    }
    // Masked before anything else is printed; only its ciphertext leaves this function.
    deps.log(`::add-mask::${token.token}`);
    const ciphertext = await deps.age.encrypt(key, token.token);
    deps.log(`Encrypted a registration token that expires at ${token.expiresAt}`);
    const registration = { login, keyId, expiresAt: token.expiresAt, ciphertext };
    return { kind: "answered", body: registrationBody(repo, registration) };
}
/**
 * Writes the answer as `github-actions[bot]`'s marked comment (the REST comment
 * list, so the job token needs only the Issues permission); a refusal also closes
 * the Issue as not planned.
 */
async function writeAnswer(deps, issue, answer) {
    const refused = answer.kind === "refused";
    const key = refused ? refusedKey : registrationKey;
    const body = refused ? refusalBody(answer.refusal) : answer.body;
    const comment = await upsertMarkedComment(deps.job, issue, key, body, "pull-request");
    deps.log(`Answered ${formatIssue(issue)}: ${comment.url}`);
    if (refused) {
        await closeIssueNotPlanned(deps.job, issue);
        deps.log(`Closed ${formatIssue(issue)} as not planned`);
    }
}
/**
 * Answers a runner request: a body without the request marker is not one; a request
 * that is no longer open is not answered again. Otherwise the request's checks
 * (`checkRequest`), the author's write or admin permission, and the SSH key it names
 * (`checkKey`) decide a refusal; else `age --version` runs before any write, the
 * optional deploy key is added, and a registration token is created, masked,
 * encrypted to that key and answered. A refusal closes the Issue as not planned. Any
 * failure is answered as "the request workflow failed (<run URL>)" with that close
 * and then thrown.
 */
async function answerRequest(input, deps) {
    const { repo, issue } = input;
    const ref = { ...repo, number: issue.number };
    const name = formatIssue(ref);
    if (!issue.body.includes(requestMarker)) {
        deps.log(`${name} is not a runner request; nothing to answer`);
        return "not-a-request";
    }
    let answer;
    try {
        const state = await readIssueState(deps.job, ref);
        if (state !== "open") {
            deps.log(`${name} is ${state}; nothing to answer`);
            return "not-open";
        }
        const check = checkRequest(issue, repo);
        answer = check.kind === "refused" ? check : await prepare(input, deps, check);
    }
    catch (error) {
        deps.log(`The request failed: ${describeFailure(error)}`);
        await writeAnswer(deps, ref, { kind: "refused", refusal: failedRefusal(input.url) });
        throw error;
    }
    if (answer.kind === "refused") {
        deps.log(`Refused: ${answer.refusal.reason}`);
    }
    await writeAnswer(deps, ref, answer);
    return answer.kind;
}

/** The commands of the Action's `command` input. */
const actionCommands = [
    "job-failed",
    "repository-dispatch",
    "runner-request",
    "wake",
];
/** The environment variable of the Action input `name`. */
function inputName(name) {
    return `INPUT_${name.toUpperCase()}`;
}
function input(env, name) {
    return env[inputName(name)];
}
function invalid(field, reason) {
    return new StageError("STAGE_INPUT_INVALID", `${field} ${reason}`);
}
/** The `command` input; anything else is invalid input, named without its value. */
function readCommand(env) {
    const value = required(input(env, "command"), inputName("command"));
    const command = actionCommands.find((candidate) => candidate === value);
    if (command === undefined) {
        throw invalid(inputName("command"), `must be one of ${actionCommands.join(", ")}`);
    }
    return command;
}
const stagePattern = /^[a-z][a-z-]*$/;
/**
 * The inputs of `job-failed`: `token`, `repo`, `issue` and `stage`, and the run URL
 * from `GITHUB_REPOSITORY` and `GITHUB_RUN_ID`. A missing or invalid field is
 * `STAGE_INPUT_INVALID` naming the field, never its value.
 */
function readJobFailedInputs(env) {
    const repo = readRepo(input(env, "repo"), inputName("repo"));
    const number = positiveInteger(input(env, "issue"), inputName("issue"));
    const stage = required(input(env, "stage"), inputName("stage"));
    if (!stagePattern.test(stage)) {
        throw invalid(inputName("stage"), "must be a stage name");
    }
    const runRepo = readRepo(env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY");
    const runId = positiveInteger(env.GITHUB_RUN_ID, "GITHUB_RUN_ID");
    return {
        token: required(input(env, "token"), inputName("token")),
        issue: { ...repo, number },
        stage,
        url: runUrl(runRepo, runId),
    };
}
/** `text` parsed as a JSON object, or `undefined` for anything else. */
function jsonObject(text) {
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return undefined;
    }
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
function readPayload(text) {
    const payload = jsonObject(text);
    if (payload === undefined) {
        throw invalid("GITHUB_EVENT_PATH", "must be the event's JSON payload");
    }
    return payload;
}
/**
 * The event from `GITHUB_EVENT_NAME` and the runner's event file
 * (`GITHUB_EVENT_PATH`, read with `readFile`), its repository (`GITHUB_REPOSITORY`)
 * and the run URL. A missing or invalid runner variable or event file is
 * `STAGE_INPUT_INVALID` naming it, never its content.
 */
function readRunEvent(env, readFile) {
    const eventName = required(env.GITHUB_EVENT_NAME, "GITHUB_EVENT_NAME");
    const path = required(env.GITHUB_EVENT_PATH, "GITHUB_EVENT_PATH");
    const repo = readRepo(env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY");
    const runId = positiveInteger(env.GITHUB_RUN_ID, "GITHUB_RUN_ID");
    let text;
    try {
        text = readFile(path);
    }
    catch {
        throw invalid("GITHUB_EVENT_PATH", "cannot be read");
    }
    return { eventName, payload: readPayload(text), repo, url: runUrl(repo, runId) };
}
/**
 * The inputs of `wake`: the run's event (`readRunEvent`) and the `token` and
 * `execution-repo` inputs as given: the wake checks them only once it needs them.
 */
function readWakeInputs(env, readFile) {
    const event = readRunEvent(env, readFile);
    return {
        ...event,
        executionRepo: input(env, "execution-repo"),
        token: input(env, "token"),
    };
}
function text(value, field, empty = false) {
    if (typeof value !== "string" || (!empty && value === "")) {
        throw invalid("GITHUB_EVENT_PATH", `has no ${field}`);
    }
    return value;
}
/** The request Issue of an `issues` event payload; a missing field is invalid. */
function readRequestIssue(payload) {
    const issue = Object(payload.issue);
    const user = Object(issue.user);
    const number = issue.number;
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
        throw invalid("GITHUB_EVENT_PATH", "has no issue.number");
    }
    return {
        number,
        title: text(issue.title, "issue.title", true),
        // GitHub sends `null` for an Issue without a body.
        body: issue.body === null ? "" : text(issue.body, "issue.body", true),
        login: text(user.login, "issue.user.login"),
        userType: text(user.type, "issue.user.type"),
    };
}
/**
 * The inputs of `runner-request`: the run's event, which must be `issues`, with the
 * request Issue's number, title, body and author (login and type) from its payload,
 * the `job-token` input (required) and the `token` input as given.
 */
function readRunnerRequestInputs(env, readFile) {
    const jobToken = required(input(env, "job-token"), inputName("job-token"));
    const event = readRunEvent(env, readFile);
    if (event.eventName !== "issues") {
        throw invalid("GITHUB_EVENT_NAME", "must be issues");
    }
    return {
        repo: event.repo,
        issue: readRequestIssue(event.payload),
        url: event.url,
        token: input(env, "token"),
        jobToken,
    };
}
/**
 * The inputs of `repository-dispatch`: `token`, `repository` (`<owner>/<repo>`),
 * `event-type` and `payload`, a JSON object. A missing or invalid field is
 * `STAGE_INPUT_INVALID` naming the field, never its value.
 */
function readRepositoryDispatchInputs(env) {
    const repository = readRepo(input(env, "repository"), inputName("repository"));
    const eventType = required(input(env, "event-type"), inputName("event-type"));
    const payload = jsonObject(required(input(env, "payload"), inputName("payload")));
    if (payload === undefined) {
        throw invalid(inputName("payload"), "must be a JSON object");
    }
    return {
        token: required(input(env, "token"), inputName("token")),
        repository,
        eventType,
        payload,
    };
}

// The Action's commands (#776). Rules live in their Core modules; this file only
// connects them to the inputs and the log.
/** The account a job's `GITHUB_TOKEN` writes as; gh-nibfin takes answers only from it. */
const jobTokenLogin = "github-actions[bot]";
const defaultActionDeps = {
    env: process.env,
    connect: (token, log) => connectClient(token, {}, log),
    connectJob: (token, log) => connectAs(token, jobTokenLogin, {}, log),
    readFile: (path) => readFileSync(path, "utf8"),
    age: (env) => createAge(env),
};
const lineLog = (io) => (line) => void io.stdout.write(`${line}\n`);
/**
 * `job-failed`: the last step of a route, finish or stage Job that failed. It adds
 * `pending` with `JOB_FAILED` unless Core already reported for the Issue
 * (`askPersonOnce`).
 */
async function jobFailed(io, deps) {
    const inputs = readJobFailedInputs(deps.env);
    const client = await deps.connect(inputs.token, lineLog(io));
    const { issue, stage, url } = inputs;
    const wrote = await askPersonOnce(client, issue, new JobFailedError(stage), url, stage);
    const name = formatIssue(issue);
    io.stdout.write(wrote
        ? `Added pending to ${name}\n`
        : `${name}: Nibfin's stop stands; left as it is\n`);
    return 0;
}
/**
 * `wake`: the job of `nibfin-events.yml` and of the user `nibfin-issue.yml`. It runs
 * `runWake`; the `token` input is required only once an event wakes an Issue.
 */
async function wake(io, deps) {
    const { token, ...input } = readWakeInputs(deps.env, deps.readFile);
    const log = lineLog(io);
    const connect = () => deps.connect(required(token, inputName("token")), log);
    await runWake(input, connect, log);
    return 0;
}
/**
 * `runner-request`: the step of `nibfin-runner-request.yml`. It answers the request
 * (`answerRequest`) with a client for `job-token` that writes as
 * `github-actions[bot]`; the `token` input is required only once the request passed
 * its body checks.
 */
async function runnerRequest(io, deps) {
    const { token, jobToken, ...input } = readRunnerRequestInputs(deps.env, deps.readFile);
    const log = lineLog(io);
    const job = await deps.connectJob(jobToken, log);
    const connect = () => deps.connect(required(token, inputName("token")), log);
    await answerRequest(input, { job, connect, age: deps.age(deps.env), log });
    return 0;
}
/**
 * `repository-dispatch`: sends the `event-type` event with the JSON `payload` to
 * `repository` (`dispatchRepository`), as `nibfin-e2e-notify.yml` asks nibfin-e2e to
 * retest a delivered Issue. The log names the event and the repository, never the
 * payload.
 */
async function repositoryDispatch(io, deps) {
    const inputs = readRepositoryDispatchInputs(deps.env);
    const client = await deps.connect(inputs.token, lineLog(io));
    const { repository, eventType, payload } = inputs;
    await dispatchRepository(client, repository, eventType, payload);
    io.stdout.write(`Sent ${eventType} to ${repository.owner}/${repository.repo}\n`);
    return 0;
}
const commands = {
    "job-failed": jobFailed,
    "repository-dispatch": repositoryDispatch,
    "runner-request": runnerRequest,
    wake,
};
/**
 * Runs the command the `command` input names and returns the exit code: 0 when it
 * did its work, 1 with the failure on stderr (its code and message, never an input's
 * value).
 */
async function runAction(io, deps) {
    try {
        return await commands[readCommand(deps.env)](io, deps);
    }
    catch (error) {
        io.stderr.write(`nibfin: ${describeFailure(error)}\n`);
        return 1;
    }
}

// The entry point of Core's JavaScript Action (`action/main.mjs` is its bundle).
process.exitCode = await runAction({ stdout: process.stdout, stderr: process.stderr }, defaultActionDeps);
