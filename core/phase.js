/*
  Copyright 2015 Google Inc. All Rights Reserved.
  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at
      http://www.apache.org/licenses/LICENSE-2.0
  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

var types = require('./types');
var streamLib = require('./stream');
var trace = require('./trace');
var stageLoader = require('./stage-loader');
var Promise = require('bluebird');
var assert = require('chai').assert;

var _instanceID = 0;
function newInstanceID() {
  return (_instanceID++) + '';
}

function phaseSpec(phase) {
  return {name: phase.name, id: phase.id};
}

function PhaseBase(info, impl, options) {
  this.name = info.name;
  this.id = (options && options.id) || newInstanceID();
  if (info.inputs !== undefined) {
    this.inputTypes = info.inputs || [];
  } else {
    this.inputType = info.input || types.unit;
  }
  if (info.outputs !== undefined) {
    this.outputTypes = info.outputs || [];
  } else {
    this.outputType = info.output || types.unit;
  }
  this.async = info.async || false;
  this.arity = info.arity;
  this.parallel = 1;
  if (this.async) {
    switch(info.arity) {
      case '0:1':
        this.impl = this.impl0To1Async;
        assert(this.inputType !== undefined);
        assert(this.outputType !== undefined);
        break;
      case '1:1':
      default:
        this.impl = this.impl1To1Async;
        assert(this.inputType !== undefined);
        assert(this.outputType !== undefined);
        break;
      case '1:N':
        this.impl = this.impl1ToNAsync;
        assert(this.inputType !== undefined);
        break;
    }
  } else {
    switch(info.arity) {
      case 'N:N':
        this.impl = this.implNToN;
        break;
      case 'N:1':
        this.impl = this.implNTo1;
        break;
      case '0:N':
        this.init = this.init0ToN;
        // 0:N phases pass inputs through untouched.
        this.impl = function(stream) {
          return Promise.resolve(done(stream));
        }
        assert(this.inputType !== undefined);
        assert(this.outputType !== undefined);
        break;
      case '1:1':
      default:
        this.impl = this.impl1To1;
        assert(this.inputType !== undefined);
        assert(this.outputType !== undefined);
        break;
      case '1:N':
        this.impl = this.impl1ToN;
        assert(this.inputType !== undefined);
        break;
    }
  }

  // default I/O
  this.inputKey = 'from';
  this.outputKey = 'from';
  this.outputValue = phaseSpec(this);
  this.makeInputList();
  this.makeOutputList();

  this.inputImpl = impl;
  this.inputOptions = options;
  this.runtime = new PhaseBaseRuntime(this, impl, options);
}

function done(stream) {
  return {command: 'done', stream: stream};
}

function none() {
  return {command: 'none'};
}

function yieldData(stream) {
  return {command: 'yield', stream: stream};
}

function par(dependencies) {
  return {command: 'par', dependencies: dependencies};
}

// TODO: remove me once stage loading doesn't need to detect
// whether we're already in a phase.
PhaseBase.prototype.isStream = true;

PhaseBase.prototype.setInput = function(name, value) {
  assert(this.inputType !== undefined);
  this.inputKey = name;
  this.inputValue = value;
  this.makeInputList();
  this.runtime = new PhaseBaseRuntime(this, this.inputImpl, this.inputOptions);
}

PhaseBase.prototype.setOutput = function(name, value) {
  assert(this.outputType !== undefined);
  this.outputKey = name;
  this.outputValue = value;
  this.makeOutputList();
  this.runtime = new PhaseBaseRuntime(this, this.inputImpl, this.inputOptions);
}

PhaseBase.prototype.makeInputList = function() {
  if (this.inputType !== undefined) {
    this.input = types.Stream([{key: this.inputKey, value: this.inputValue, type: this.inputType}]);
  } else {
    this.input = types.Stream(this.inputTypes);
  }
}

PhaseBase.prototype.makeOutputList = function() {
  if (this.outputType !== undefined) {
    this.output = types.Stream([{key: this.outputKey, value: this.outputValue, type: this.outputType}]);
  } else {
    this.output = types.Stream(this.outputTypes);
  }
}

function Tags(tags) {
  this.tags = tags;
}

PhaseBase.prototype.implNToN = function(stream) {
  this.runtime.stream = stream;
  this.runtime.get = function(key, value, f) {
    this.stream.get(key, value, function(data) {
      this.setTags(data.tags);
      f(data.data);
    }.bind(this));
  }.bind(this.runtime);
  var t = trace.start(this.runtime);
  this.runtime.impl();
  t.end();
  return Promise.resolve(done(stream));
}

PhaseBase.prototype.init0ToN = function(handle) {
  this.runtime.setTags({});
  var t = trace.start(this.runtime);
  this.runtime.stream = new streamLib.Stream();
  this.runtime.sendData = function(data) {
    t.end();
    this.put(data);
    this.setTags({});
  }.bind(this.runtime);
  this.runtime.impl(this.runtime.tags);
  handle(this.runtime.stream);
};

function getFrame(item) {
  var frame = item.tags.frame;
  assert(frame && frame.length);
  return frame[frame.length - 1];
}

PhaseBase.prototype.implNTo1 = function(stream) {
  this.runtime.stream = stream;
  this.pendingItems = stream.get(this.inputKey, this.inputValue);
  this.backlog = this.backlog || [];
  this.upto = this.upto || 0;

  var pushToBacklog = function(item) {
    var frame = getFrame(item);
    for (var i = 0; i < this.backlog.length; i++) {
      if (getFrame(this.backlog[i]).seq > frame.seq) {
        this.backlog.splice(i, 0, item);
        return;
      }
    }
    this.backlog.push(item);
  }.bind(this);

  var processFromBacklog = function() {
    while (this.backlog.length > 0 && getFrame(this.backlog[0]).seq == this.upto) {
      processItem(this.backlog[0]);
      this.backlog.splice(0, 1);
    }
  }.bind(this)

  var processItem = function(item) {
    if (getFrame(item).start) {
      this.baseStream = stream;
      this.runtime.onStart();
      this.started = true;
    }
    this.runtime.setTags(item.tags);
    this.runtime.impl(item.data, this.runtime.tags);
    if (getFrame(item).end) {
      this.groupCompleted();
      this.started = false;
      this.data = true;
    }
    assert(this.upto == getFrame(item).seq);
    this.upto++;
  }.bind(this)
        
  this.data = false;

  for (var i = 0; i < this.pendingItems.length; i++) {
    var frame = getFrame(this.pendingItems[i]);
    if (frame.seq !== this.upto) {
      processFromBacklog();
      if (frame.seq !== this.upto) {
        pushToBacklog(this.pendingItems[i]);
        continue;
      }
    }
    processItem(this.pendingItems[i]);
  }
  processFromBacklog();
  if (this.data) {
    return Promise.resolve(done(this.baseStream));
  }
  else {
    return Promise.resolve(none());
  }
}

PhaseBase.prototype.groupCompleted = function() {
  this.runtime.stream = this.baseStream;
  var frame = this.runtime.tags.read('frame');
  frame = frame.slice(0, frame.length - 1);
  this.runtime.setTags({});
  var result = this.runtime.onCompletion();
  this.runtime.tags.tag(this.outputKey, this.outputValue);
  this.runtime.tags.tag('frame', frame);
  this.runtime.put(result);
  return this.runtime.stream;
}

function flowItemGet(runtime, tags) {
  if (!trace.enabled) return;
  var args = {tags: {}};
  for (var k in tags) {
    if (k != 'flow')
      args.tags[k] = tags[k];
  }
  args.streamID = runtime.stream.id;
  var t = trace.start({cat: 'phase', name: 'get:' + runtime.phaseBase.name, args: args});
  if (tags.flow) {
    tags.flow.step();
  }
  t.end();
}

function flowItemPut(runtime, tags) {
  if (!trace.enabled) return;
  var args = {tags: {}};
  for (var k in tags) {
    if (k != 'flow')
      args.tags[k] = tags[k];
  }
  args.streamID = runtime.stream.id;
  var t = trace.start({cat: 'phase', name: 'put:' + runtime.phaseBase.name, args: args});
  if (tags.flow) {
    tags.flow.step();
  }
  tags.flow = trace.flow(runtime).start();
  t.end();
}

PhaseBase.prototype.impl1To1 = function(stream) {

  if (!this.pendingItems || !this.pendingItems.length) {
    this.runtime.stream = stream;
    this.pendingItems = stream.get(this.inputKey, this.inputValue);
    this.index = 0;
  }

  for (; this.index < this.pendingItems.length;) {
    var item = this.pendingItems[this.index++];
    var t = trace.start(this.runtime); flowItemGet(this.runtime, item.tags);
    this.runtime.setTags(item.tags);
    var result = this.runtime.impl(item.data, this.runtime.tags);
    this.runtime.tags.tag(this.outputKey, this.outputValue);
    this.runtime.put(result);
    t.end();

    if (this.runtime.yielding && this.index < this.pendingItems.length) {
      var result = yieldData(this.runtime.stream);
      this.runtime.newStream();
      return Promise.resolve(result);
    }
  }
  this.pendingItems = [];

  if (!this.runtime.yielding) {
    return Promise.resolve(done(stream));
  } else {
    return Promise.resolve(done(this.runtime.stream));
  }
}

PhaseBase.prototype.impl1To1Async = function(stream) {
  this.runtime.stream = stream;
  var items = stream.get(this.inputKey, this.inputValue);
  var phase = this;
  return Promise.resolve(par(items.map(function(item) {
    return function() {
      var runtime = new PhaseBaseRuntime(phase, phase.inputImpl, phase.inputOptions);
      runtime.stream = stream;
      runtime.setTags(item.tags);
      var t = trace.start(runtime); flowItemGet(runtime, item.tags);
      var result = runtime.impl(item.data, runtime.tags);
      t.end();
      return result.then(trace.wrap(trace.enabled && {cat: 'phase', name: 'finish:' + phase.name}, function(result) {
        runtime.put(result);
      }));
    };
  })));
}

function closeFrame(runtime) {
  var frames = runtime.lastFrame;
  if (frames == undefined)
    return;
  var frame = frames[frames.length - 1];
  frame.end = true;
}

PhaseBase.prototype.impl1ToN = function(stream) {
  this.sequenceNumber = this.sequenceNumber || 0;
  this.runtime.stream = stream;
  stream.get(this.inputKey, this.inputValue).forEach(function(item) {
    var t = trace.start(this.runtime); flowItemGet(this.runtime, item.tags);
    this.runtime.setTags(item.tags);
    this.runtime.hasStarted = false;
    this.runtime.impl(item.data, this.runtime.tags);
    this.runtime.hasStarted = undefined;
    closeFrame(this.runtime);
    t.end();
  }.bind(this));
  return Promise.resolve(done(stream));
}

PhaseBase.prototype.impl1ToNAsync = function(stream) {
  this.sequenceNumber = this.sequenceNumber || 0;
  this.runtime.stream = stream;
  var items = stream.get(this.inputKey, this.inputValue);
  var phase = this;
  return Promise.resolve(par(items.map(function(item) {
    return function() {
      var runtime = new PhaseBaseRuntime(phase, phase.inputImpl, phase.inputOptions);
      runtime.stream = stream;
      runtime.setTags(item.tags);
      var t = trace.start(runtime); flowItemGet(runtime, item.tags);
      runtime.hasStarted = false;
      var result = runtime.impl(item.data, runtime.tags);
      runtime.hasStarted = undefined;
      var flow = trace.flow({cat: 'phase', name: phase.name}).start();
      t.end();
      return result.then(trace.wrap(trace.enabled && {cat: 'phase', name: 'finish:' + phase.name}, function(result) {
        closeFrame(runtime);
        flow.end();
      }));
    };
  })));
}

Tags.prototype.clone = function() {
  var result = {};
  for (var key in this.tags)
    result[key] = this.tags[key];
  return new Tags(result);
}

Tags.prototype.tag = function(key, value) {
  this.tags[key] = value;
  return this;
}

Tags.prototype.read = function(key) {
  return this.tags[key];
}

function getFunction(type) {
  return function(f) {
    this.stream.get(type.key, type.value).forEach(function(data) {
      flowItemGet(this, data.tags);
      this.setTags(data.tags);
      f(data.data);
    }.bind(this));
  }
}

function putFunction(type) {
  return function(data, tags) {
    if (tags) {
      this.tags = new Tags(tags);
    } else {
      this.tags = this.baseTags.clone();
    }
    // TODO: This misses tags when they are set after calling put().
    flowItemPut(this, this.tags.tags);
    this.tags.tag(type.key, type.value);
    // FIXME: this.hasStarted only defined for 1:N phases, but this
    // is a hacky way to signal that we need framing. Make more better.
    if (this.hasStarted !== undefined) {
      var oldValue = (this.tags.read('frame') || []).slice();
      var frame = {};
      if (!this.hasStarted) {
        frame.start = true;
      }
      frame.seq = this.phaseBase.sequenceNumber++;
      oldValue.push(frame);
      this.tags.tag('frame', oldValue);
      this.hasStarted = true;
      this.lastFrame = oldValue;
    }
    this.stream.put(data, this.tags.tags);
    return this.tags;
  }
}

function PhaseBaseRuntime(base, impl, options) {
  this.phaseBase = base;
  this.options = options;

  // setup put/get
  // TODO: Check against type constraints / add to type constraints
  // TODO: use these for base get/put in arity 1 cases?
  // TODO: don't install get/put in arity 1 cases
  if (this.phaseBase.inputTypes !== undefined) {
    this.inputs = {}
    for (var i = 0; i < this.phaseBase.inputTypes.length; i++)
      this.inputs[this.phaseBase.inputTypes[i].name] = {get: getFunction(this.phaseBase.inputTypes[i]).bind(this)};
  } else {
    this.get = getFunction({key: this.phaseBase.inputKey, value: this.phaseBase.inputValue});
  }
  if (this.phaseBase.outputTypes !== undefined) {
    this.outputs = {};
    for (var i = 0; i < this.phaseBase.outputTypes.length; i++)
      this.outputs[this.phaseBase.outputTypes[i].name] = {put: putFunction(this.phaseBase.outputTypes[i]).bind(this)};
  } else {
    this.put = putFunction({key: this.phaseBase.outputKey, value: this.phaseBase.outputValue});
  }
  if (impl.impl) {
    this.impl = impl.impl;
    this.onCompletion = impl.onCompletion || function() {};
    this.onStart = impl.onStart || function() {};
  } else {
    this.impl = impl;
  }
}

PhaseBaseRuntime.prototype.toTraceInfo = function() {
  return {cat: 'phase', name: this.phaseBase.name, args: {pipeId: this.phaseBase.pipeId}};
};

PhaseBaseRuntime.prototype.setTags = function(tags) {
  this.baseTags = new Tags(tags);
  this.tags = this.baseTags;
}

PhaseBaseRuntime.prototype.newStream = function() {
  this.stream = new streamLib.Stream();
}

PhaseBaseRuntime.prototype.yield = function(data) {
  this.yielding = true;
  return data;
}

function pipeline(phases) {
  return new PhaseBase({
    name: 'pipeline',
    input: phases[0].inputType,
    output: phases[phases.length - 1].outputType,
    arity: '1:N',
    async: true,
  }, function(data, tags) {
    var runtime = this;
    return new Promise(function(resolve, reject) {
      var stream = new streamLib.Stream();
      stream.put(data, tags.tags);
      stageLoader.processStagesWithInput(stream, phases, function(stream) {
        for (var i = 0; i < stream.data.length; i++) {
          runtime.put(stream.data[i].data, stream.data[i].tags);
        }
        resolve();
      }, reject);
    });
  },
  {});
}

function routingPhase(inRoutes, outRoutes) {
  assert(inRoutes.length == outRoutes.length);
  var inputDict = {};
  var outputDict = {};
  for (var i = 0; i < inRoutes.length; i++) {
    var typeVar = types.newTypeVar();
    for (var j = 0; j < inRoutes[i].length; j++)
      inputDict[inRoutes[i][j]] = {key: 'eto', value: inRoutes[i][j], type: typeVar, name: inRoutes[i][j]};
    for (var k = 0; k < outRoutes[i].length; k++)
      outputDict[outRoutes[i][k]] = {key: 'efrom', value: outRoutes[i][k], type: typeVar, name: outRoutes[i][k]};
  }
  var inputs = [];
  var outputs = [];
  var keys = Object.keys(inputDict);
  for (var i = 0; i < keys.length; i++)
    inputs.push(inputDict[keys[i]]);
  var keys = Object.keys(outputDict);
  for (var i = 0; i < keys.length; i++)
    outputs.push(outputDict[keys[i]]);

  var phase = new PhaseBase({
    name: 'routing',
    arity: 'N:N',
    inputs: inputs,
    outputs: outputs,
  }, function(stream) {
    for (var i = 0; i < inRoutes.length; i++) {
      var ins = inRoutes[i];
      var outs = outRoutes[i];
      for (var j = 0; j < ins.length; j++) {
        this.inputs[ins[j]].get(function(data) {
          for (var k = 0; k < outs.length; k++) {
            this.outputs[outs[k]].put(data);
          }
        }.bind(this));
      }
    }
  });
  return phase;
}

module.exports.PhaseBase = PhaseBase;
module.exports.pipeline = pipeline;
module.exports.routingPhase = routingPhase;
