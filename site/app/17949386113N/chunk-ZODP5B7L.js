var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __reExport = (target, mod, secondTarget) => (__copyProps(target, mod, "default"), secondTarget && __copyProps(secondTarget, mod, "default"));
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// ../node_modules/.pnpm/react@19.3.1/node_modules/react/cjs/react.development.js
var require_react_development = __commonJS({
  "../node_modules/.pnpm/react@19.3.1/node_modules/react/cjs/react.development.js"(exports, module) {
    "use strict";
    (function() {
      function defineDeprecationWarning(methodName, info) {
        Object.defineProperty(Component.prototype, methodName, {
          get: function() {
            console.warn(
              "%s(...) is deprecated in plain JavaScript React classes. %s",
              info[0],
              info[1]
            );
          }
        });
      }
      function getIteratorFn(maybeIterable) {
        if (null === maybeIterable || "object" !== typeof maybeIterable)
          return null;
        maybeIterable = MAYBE_ITERATOR_SYMBOL && maybeIterable[MAYBE_ITERATOR_SYMBOL] || maybeIterable["@@iterator"];
        return "function" === typeof maybeIterable ? maybeIterable : null;
      }
      function warnNoop(publicInstance, callerName) {
        publicInstance = (publicInstance = publicInstance.constructor) && (publicInstance.displayName || publicInstance.name) || "ReactClass";
        var warningKey = publicInstance + "." + callerName;
        didWarnStateUpdateForUnmountedComponent[warningKey] || (console.error(
          "Can't call %s on a component that is not yet mounted. This is a no-op, but it might indicate a bug in your application. Instead, assign to `this.state` directly or define a `state = {};` class property with the desired state in the %s component.",
          callerName,
          publicInstance
        ), didWarnStateUpdateForUnmountedComponent[warningKey] = true);
      }
      function Component(props, context, updater) {
        this.props = props;
        this.context = context;
        this.refs = emptyObject;
        this.updater = updater || ReactNoopUpdateQueue;
      }
      function ComponentDummy() {
      }
      function PureComponent(props, context, updater) {
        this.props = props;
        this.context = context;
        this.refs = emptyObject;
        this.updater = updater || ReactNoopUpdateQueue;
      }
      function noop() {
      }
      function testStringCoercion(value) {
        return "" + value;
      }
      function checkKeyStringCoercion(value) {
        try {
          testStringCoercion(value);
          var JSCompiler_inline_result = false;
        } catch (e) {
          JSCompiler_inline_result = true;
        }
        if (JSCompiler_inline_result) {
          JSCompiler_inline_result = console;
          var JSCompiler_temp_const = JSCompiler_inline_result.error;
          var JSCompiler_inline_result$jscomp$0 = "function" === typeof Symbol && Symbol.toStringTag && value[Symbol.toStringTag] || value.constructor.name || "Object";
          JSCompiler_temp_const.call(
            JSCompiler_inline_result,
            "The provided key is an unsupported type %s. This value must be coerced to a string before using it here.",
            JSCompiler_inline_result$jscomp$0
          );
          return testStringCoercion(value);
        }
      }
      function getComponentNameFromType(type) {
        if (null == type) return null;
        if ("function" === typeof type)
          return type.$$typeof === REACT_CLIENT_REFERENCE ? null : type.displayName || type.name || null;
        if ("string" === typeof type) return type;
        switch (type) {
          case REACT_FRAGMENT_TYPE:
            return "Fragment";
          case REACT_PROFILER_TYPE:
            return "Profiler";
          case REACT_STRICT_MODE_TYPE:
            return "StrictMode";
          case REACT_SUSPENSE_TYPE:
            return "Suspense";
          case REACT_SUSPENSE_LIST_TYPE:
            return "SuspenseList";
          case REACT_ACTIVITY_TYPE:
            return "Activity";
          case REACT_VIEW_TRANSITION_TYPE:
            return "ViewTransition";
        }
        if ("object" === typeof type)
          switch ("number" === typeof type.tag && console.error(
            "Received an unexpected object in getComponentNameFromType(). This is likely a bug in React. Please file an issue."
          ), type.$$typeof) {
            case REACT_PORTAL_TYPE:
              return "Portal";
            case REACT_CONTEXT_TYPE:
              return type.displayName || "Context";
            case REACT_CONSUMER_TYPE:
              return (type._context.displayName || "Context") + ".Consumer";
            case REACT_FORWARD_REF_TYPE:
              var innerType = type.render;
              type = type.displayName;
              type || (type = innerType.displayName || innerType.name || "", type = "" !== type ? "ForwardRef(" + type + ")" : "ForwardRef");
              return type;
            case REACT_MEMO_TYPE:
              return innerType = type.displayName || null, null !== innerType ? innerType : getComponentNameFromType(type.type) || "Memo";
            case REACT_LAZY_TYPE:
              innerType = type._payload;
              type = type._init;
              try {
                return getComponentNameFromType(type(innerType));
              } catch (x) {
              }
          }
        return null;
      }
      function getTaskName(type) {
        if (type === REACT_FRAGMENT_TYPE) return "<>";
        if ("object" === typeof type && null !== type && type.$$typeof === REACT_LAZY_TYPE)
          return "<...>";
        try {
          var name = getComponentNameFromType(type);
          return name ? "<" + name + ">" : "<...>";
        } catch (x) {
          return "<...>";
        }
      }
      function getOwner() {
        var dispatcher = ReactSharedInternals.A;
        return null === dispatcher ? null : dispatcher.getOwner();
      }
      function UnknownOwner() {
        return Error("react-stack-top-frame");
      }
      function hasValidKey(config) {
        if (hasOwnProperty.call(config, "key")) {
          var getter = Object.getOwnPropertyDescriptor(config, "key").get;
          if (getter && getter.isReactWarning) return false;
        }
        return void 0 !== config.key;
      }
      function defineKeyPropWarningGetter(props, displayName) {
        function warnAboutAccessingKey() {
          specialPropKeyWarningShown || (specialPropKeyWarningShown = true, console.error(
            "%s: `key` is not a prop. Trying to access it will result in `undefined` being returned. If you need to access the same value within the child component, you should pass it as a different prop. (https://react.dev/link/special-props)",
            displayName
          ));
        }
        warnAboutAccessingKey.isReactWarning = true;
        Object.defineProperty(props, "key", {
          get: warnAboutAccessingKey,
          configurable: true
        });
      }
      function elementRefGetterWithDeprecationWarning() {
        var componentName = getComponentNameFromType(this.type);
        didWarnAboutElementRef[componentName] || (didWarnAboutElementRef[componentName] = true, console.error(
          "Accessing element.ref was removed in React 19. ref is now a regular prop. It will be removed from the JSX Element type in a future release."
        ));
        componentName = this.props.ref;
        return void 0 !== componentName ? componentName : null;
      }
      function ReactElement(type, key, props, owner, debugStack, debugTask) {
        var refProp = props.ref;
        type = {
          $$typeof: REACT_ELEMENT_TYPE,
          type,
          key,
          props,
          _owner: owner
        };
        null !== (void 0 !== refProp ? refProp : null) ? Object.defineProperty(type, "ref", {
          enumerable: false,
          get: elementRefGetterWithDeprecationWarning
        }) : Object.defineProperty(type, "ref", { enumerable: false, value: null });
        type._store = {};
        Object.defineProperty(type._store, "validated", {
          configurable: false,
          enumerable: false,
          writable: true,
          value: 0
        });
        Object.defineProperty(type, "_debugInfo", {
          configurable: false,
          enumerable: false,
          writable: true,
          value: null
        });
        Object.defineProperty(type, "_debugStack", {
          configurable: false,
          enumerable: false,
          writable: true,
          value: debugStack
        });
        Object.defineProperty(type, "_debugTask", {
          configurable: false,
          enumerable: false,
          writable: true,
          value: debugTask
        });
        Object.freeze && (Object.freeze(type.props), Object.freeze(type));
        return type;
      }
      function cloneAndReplaceKey(oldElement, newKey) {
        newKey = ReactElement(
          oldElement.type,
          newKey,
          oldElement.props,
          oldElement._owner,
          oldElement._debugStack,
          oldElement._debugTask
        );
        oldElement._store && (newKey._store.validated = oldElement._store.validated);
        return newKey;
      }
      function validateChildKeys(node) {
        isValidElement(node) ? node._store && (node._store.validated = 1) : "object" === typeof node && null !== node && node.$$typeof === REACT_LAZY_TYPE && ("fulfilled" === node._payload.status ? isValidElement(node._payload.value) && node._payload.value._store && (node._payload.value._store.validated = 1) : node._store && (node._store.validated = 1));
      }
      function isValidElement(object) {
        return "object" === typeof object && null !== object && object.$$typeof === REACT_ELEMENT_TYPE;
      }
      function escape(key) {
        var escaperLookup = { "=": "=0", ":": "=2" };
        return "$" + key.replace(/[=:]/g, function(match) {
          return escaperLookup[match];
        });
      }
      function getElementKey(element, index) {
        return "object" === typeof element && null !== element && null != element.key ? (checkKeyStringCoercion(element.key), escape("" + element.key)) : index.toString(36);
      }
      function resolveThenable(thenable) {
        switch (thenable.status) {
          case "fulfilled":
            return thenable.value;
          case "rejected":
            throw thenable.reason;
          default:
            switch ("string" === typeof thenable.status ? thenable.then(noop, noop) : (thenable.status = "pending", thenable.then(
              function(fulfilledValue) {
                "pending" === thenable.status && (thenable.status = "fulfilled", thenable.value = fulfilledValue);
              },
              function(error) {
                "pending" === thenable.status && (thenable.status = "rejected", thenable.reason = error);
              }
            )), thenable.status) {
              case "fulfilled":
                return thenable.value;
              case "rejected":
                throw thenable.reason;
            }
        }
        throw thenable;
      }
      function mapIntoArray(children, array, escapedPrefix, nameSoFar, callback) {
        var type = typeof children;
        if ("undefined" === type || "boolean" === type) children = null;
        var invokeCallback = false;
        if (null === children) invokeCallback = true;
        else
          switch (type) {
            case "bigint":
            case "string":
            case "number":
              invokeCallback = true;
              break;
            case "object":
              switch (children.$$typeof) {
                case REACT_ELEMENT_TYPE:
                case REACT_PORTAL_TYPE:
                  invokeCallback = true;
                  break;
                case REACT_LAZY_TYPE:
                  return invokeCallback = children._init, mapIntoArray(
                    invokeCallback(children._payload),
                    array,
                    escapedPrefix,
                    nameSoFar,
                    callback
                  );
              }
          }
        if (invokeCallback) {
          invokeCallback = children;
          callback = callback(invokeCallback);
          var childKey = "" === nameSoFar ? "." + getElementKey(invokeCallback, 0) : nameSoFar;
          isArrayImpl(callback) ? (escapedPrefix = "", null != childKey && (escapedPrefix = childKey.replace(userProvidedKeyEscapeRegex, "$&/") + "/"), mapIntoArray(callback, array, escapedPrefix, "", function(c) {
            return c;
          })) : null != callback && (isValidElement(callback) && (null != callback.key && (invokeCallback && invokeCallback.key === callback.key || checkKeyStringCoercion(callback.key)), escapedPrefix = cloneAndReplaceKey(
            callback,
            escapedPrefix + (null == callback.key || invokeCallback && invokeCallback.key === callback.key ? "" : ("" + callback.key).replace(
              userProvidedKeyEscapeRegex,
              "$&/"
            ) + "/") + childKey
          ), "" !== nameSoFar && null != invokeCallback && isValidElement(invokeCallback) && null == invokeCallback.key && invokeCallback._store && !invokeCallback._store.validated && (escapedPrefix._store.validated = 2), callback = escapedPrefix), array.push(callback));
          return 1;
        }
        invokeCallback = 0;
        childKey = "" === nameSoFar ? "." : nameSoFar + ":";
        if (isArrayImpl(children))
          for (var i = 0; i < children.length; i++)
            nameSoFar = children[i], type = childKey + getElementKey(nameSoFar, i), invokeCallback += mapIntoArray(
              nameSoFar,
              array,
              escapedPrefix,
              type,
              callback
            );
        else if (i = getIteratorFn(children), "function" === typeof i)
          for (i === children.entries && (didWarnAboutMaps || console.warn(
            "Using Maps as children is not supported. Use an array of keyed ReactElements instead."
          ), didWarnAboutMaps = true), children = i.call(children), i = 0; !(nameSoFar = children.next()).done; )
            nameSoFar = nameSoFar.value, type = childKey + getElementKey(nameSoFar, i++), invokeCallback += mapIntoArray(
              nameSoFar,
              array,
              escapedPrefix,
              type,
              callback
            );
        else if ("object" === type) {
          if ("function" === typeof children.then)
            return mapIntoArray(
              resolveThenable(children),
              array,
              escapedPrefix,
              nameSoFar,
              callback
            );
          array = String(children);
          throw Error(
            "Objects are not valid as a React child (found: " + ("[object Object]" === array ? "object with keys {" + Object.keys(children).join(", ") + "}" : array) + "). If you meant to render a collection of children, use an array instead."
          );
        }
        return invokeCallback;
      }
      function mapChildren(children, func, context) {
        if (null == children) return children;
        var result = [], count = 0;
        mapIntoArray(children, result, "", "", function(child) {
          return func.call(context, child, count++);
        });
        return result;
      }
      function lazyInitializer(payload) {
        if (-1 === payload._status) {
          var resolveDebugValue = null, rejectDebugValue = null, ioInfo = payload._ioInfo;
          null != ioInfo && (ioInfo.start = ioInfo.end = performance.now(), ioInfo.value = new Promise(function(resolve, reject) {
            resolveDebugValue = resolve;
            rejectDebugValue = reject;
          }));
          ioInfo = payload._result;
          var thenable = ioInfo();
          thenable.then(
            function(moduleObject) {
              if (0 === payload._status || -1 === payload._status) {
                payload._status = 1;
                payload._result = moduleObject;
                var _ioInfo = payload._ioInfo;
                if (null != _ioInfo) {
                  _ioInfo.end = performance.now();
                  var debugValue = null == moduleObject ? void 0 : moduleObject.default;
                  resolveDebugValue(debugValue);
                  _ioInfo.value.status = "fulfilled";
                  _ioInfo.value.value = debugValue;
                }
                void 0 === thenable.status && (thenable.status = "fulfilled", thenable.value = moduleObject);
              }
            },
            function(error) {
              if (0 === payload._status || -1 === payload._status) {
                payload._status = 2;
                payload._result = error;
                var _ioInfo2 = payload._ioInfo;
                null != _ioInfo2 && (_ioInfo2.end = performance.now(), _ioInfo2.value.then(noop, noop), rejectDebugValue(error), _ioInfo2.value.status = "rejected", _ioInfo2.value.reason = error);
                void 0 === thenable.status && (thenable.status = "rejected", thenable.reason = error);
              }
            }
          );
          ioInfo = payload._ioInfo;
          if (null != ioInfo) {
            var displayName = thenable.displayName;
            "string" === typeof displayName && (ioInfo.name = displayName);
          }
          -1 === payload._status && (payload._status = 0, payload._result = thenable);
        }
        if (1 === payload._status)
          return ioInfo = payload._result, void 0 === ioInfo && console.error(
            "lazy: Expected the result of a dynamic import() call. Instead received: %s\n\nYour code should look like: \n  const MyComponent = lazy(() => import('./MyComponent'))\n\nDid you accidentally put curly braces around the import?",
            ioInfo
          ), "default" in ioInfo || console.error(
            "lazy: Expected the result of a dynamic import() call. Instead received: %s\n\nYour code should look like: \n  const MyComponent = lazy(() => import('./MyComponent'))",
            ioInfo
          ), ioInfo.default;
        throw payload._result;
      }
      function resolveDispatcher() {
        var dispatcher = ReactSharedInternals.H;
        null === dispatcher && console.error(
          "Invalid hook call. Hooks can only be called inside of the body of a function component. This could happen for one of the following reasons:\n1. You might have mismatching versions of React and the renderer (such as React DOM)\n2. You might be breaking the Rules of Hooks\n3. You might have more than one copy of React in the same app\nSee https://react.dev/link/invalid-hook-call for tips about how to debug and fix this problem."
        );
        return dispatcher;
      }
      function releaseAsyncTransition() {
        ReactSharedInternals.asyncTransitions--;
      }
      function startTransition(scope) {
        var prevTransition = ReactSharedInternals.T, currentTransition = {};
        currentTransition.types = null !== prevTransition ? prevTransition.types : null;
        currentTransition._updatedFibers = /* @__PURE__ */ new Set();
        ReactSharedInternals.T = currentTransition;
        try {
          var returnValue = scope(), onStartTransitionFinish = ReactSharedInternals.S;
          null !== onStartTransitionFinish && onStartTransitionFinish(currentTransition, returnValue);
          "object" === typeof returnValue && null !== returnValue && "function" === typeof returnValue.then && (ReactSharedInternals.asyncTransitions++, returnValue.then(releaseAsyncTransition, releaseAsyncTransition), returnValue.then(noop, reportGlobalError));
        } catch (error) {
          reportGlobalError(error);
        } finally {
          null === prevTransition && currentTransition._updatedFibers && (scope = currentTransition._updatedFibers.size, currentTransition._updatedFibers.clear(), 10 < scope && console.warn(
            "Detected a large number of updates inside startTransition. If this is due to a subscription please re-write it to use React provided hooks. Otherwise concurrent mode guarantees are off the table."
          )), null !== prevTransition && null !== currentTransition.types && (null !== prevTransition.types && prevTransition.types !== currentTransition.types && console.error(
            "We expected inner Transitions to have transferred the outer types set and that you cannot add to the outer Transition while inside the inner.This is a bug in React."
          ), prevTransition.types = currentTransition.types), ReactSharedInternals.T = prevTransition;
        }
      }
      function addTransitionType(type) {
        var transition = ReactSharedInternals.T;
        if (null !== transition) {
          var transitionTypes = transition.types;
          null === transitionTypes ? transition.types = [type] : -1 === transitionTypes.indexOf(type) && transitionTypes.push(type);
        } else
          0 === ReactSharedInternals.asyncTransitions && console.error(
            "addTransitionType can only be called inside a `startTransition()` callback. It must be associated with a specific Transition."
          ), startTransition(addTransitionType.bind(null, type));
      }
      function enqueueTask(task) {
        if (null === enqueueTaskImpl)
          try {
            var requireString = ("require" + Math.random()).slice(0, 7);
            enqueueTaskImpl = (module && module[requireString]).call(
              module,
              "timers"
            ).setImmediate;
          } catch (_err) {
            enqueueTaskImpl = function(callback) {
              false === didWarnAboutMessageChannel && (didWarnAboutMessageChannel = true, "undefined" === typeof MessageChannel && console.error(
                "This browser does not have a MessageChannel implementation, so enqueuing tasks via await act(async () => ...) will fail. Please file an issue at https://github.com/facebook/react/issues if you encounter this warning."
              ));
              var channel = new MessageChannel();
              channel.port1.onmessage = callback;
              channel.port2.postMessage(void 0);
            };
          }
        return enqueueTaskImpl(task);
      }
      function aggregateErrors(errors) {
        return 1 < errors.length && "function" === typeof AggregateError ? new AggregateError(errors) : errors[0];
      }
      function popActScope(prevActQueue, prevActScopeDepth) {
        prevActScopeDepth !== actScopeDepth - 1 && console.error(
          "You seem to have overlapping act() calls, this is not supported. Be sure to await previous act() calls before making a new one. "
        );
        actScopeDepth = prevActScopeDepth;
      }
      function recursivelyFlushAsyncActWork(returnValue, resolve, reject) {
        var queue = ReactSharedInternals.actQueue;
        if (null !== queue)
          if (0 !== queue.length)
            try {
              flushActQueue(queue);
              enqueueTask(function() {
                return recursivelyFlushAsyncActWork(returnValue, resolve, reject);
              });
              return;
            } catch (error) {
              ReactSharedInternals.thrownErrors.push(error);
            }
          else ReactSharedInternals.actQueue = null;
        0 < ReactSharedInternals.thrownErrors.length ? (queue = aggregateErrors(ReactSharedInternals.thrownErrors), ReactSharedInternals.thrownErrors.length = 0, reject(queue)) : resolve(returnValue);
      }
      function flushActQueue(queue) {
        if (!isFlushing) {
          isFlushing = true;
          var i = 0;
          try {
            for (; i < queue.length; i++) {
              var callback = queue[i];
              do {
                ReactSharedInternals.didUsePromise = false;
                var continuation = callback(false);
                if (null !== continuation) {
                  if (ReactSharedInternals.didUsePromise) {
                    queue[i] = callback;
                    queue.splice(0, i);
                    return;
                  }
                  callback = continuation;
                } else break;
              } while (1);
            }
            queue.length = 0;
          } catch (error) {
            queue.splice(0, i + 1), ReactSharedInternals.thrownErrors.push(error);
          } finally {
            isFlushing = false;
          }
        }
      }
      "undefined" !== typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ && "function" === typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStart && __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStart(Error());
      var REACT_ELEMENT_TYPE = /* @__PURE__ */ Symbol.for("react.transitional.element"), REACT_PORTAL_TYPE = /* @__PURE__ */ Symbol.for("react.portal"), REACT_FRAGMENT_TYPE = /* @__PURE__ */ Symbol.for("react.fragment"), REACT_STRICT_MODE_TYPE = /* @__PURE__ */ Symbol.for("react.strict_mode"), REACT_PROFILER_TYPE = /* @__PURE__ */ Symbol.for("react.profiler"), REACT_CONSUMER_TYPE = /* @__PURE__ */ Symbol.for("react.consumer"), REACT_CONTEXT_TYPE = /* @__PURE__ */ Symbol.for("react.context"), REACT_FORWARD_REF_TYPE = /* @__PURE__ */ Symbol.for("react.forward_ref"), REACT_SUSPENSE_TYPE = /* @__PURE__ */ Symbol.for("react.suspense"), REACT_SUSPENSE_LIST_TYPE = /* @__PURE__ */ Symbol.for("react.suspense_list"), REACT_MEMO_TYPE = /* @__PURE__ */ Symbol.for("react.memo"), REACT_LAZY_TYPE = /* @__PURE__ */ Symbol.for("react.lazy"), REACT_ACTIVITY_TYPE = /* @__PURE__ */ Symbol.for("react.activity"), REACT_VIEW_TRANSITION_TYPE = /* @__PURE__ */ Symbol.for("react.view_transition"), MAYBE_ITERATOR_SYMBOL = Symbol.iterator, didWarnStateUpdateForUnmountedComponent = {}, ReactNoopUpdateQueue = {
        isMounted: function() {
          return false;
        },
        enqueueForceUpdate: function(publicInstance) {
          warnNoop(publicInstance, "forceUpdate");
        },
        enqueueReplaceState: function(publicInstance) {
          warnNoop(publicInstance, "replaceState");
        },
        enqueueSetState: function(publicInstance) {
          warnNoop(publicInstance, "setState");
        }
      }, assign = Object.assign, emptyObject = {};
      Object.freeze(emptyObject);
      Component.prototype.isReactComponent = {};
      Component.prototype.setState = function(partialState, callback) {
        if ("object" !== typeof partialState && "function" !== typeof partialState && null != partialState)
          throw Error(
            "takes an object of state variables to update or a function which returns an object of state variables."
          );
        this.updater.enqueueSetState(this, partialState, callback, "setState");
      };
      Component.prototype.forceUpdate = function(callback) {
        this.updater.enqueueForceUpdate(this, callback, "forceUpdate");
      };
      var deprecatedAPIs = {
        isMounted: [
          "isMounted",
          "Instead, make sure to clean up subscriptions and pending requests in componentWillUnmount to prevent memory leaks."
        ],
        replaceState: [
          "replaceState",
          "Refactor your code to use setState instead (see https://github.com/facebook/react/issues/3236)."
        ]
      };
      for (fnName in deprecatedAPIs)
        deprecatedAPIs.hasOwnProperty(fnName) && defineDeprecationWarning(fnName, deprecatedAPIs[fnName]);
      ComponentDummy.prototype = Component.prototype;
      deprecatedAPIs = PureComponent.prototype = new ComponentDummy();
      deprecatedAPIs.constructor = PureComponent;
      assign(deprecatedAPIs, Component.prototype);
      deprecatedAPIs.isPureReactComponent = true;
      var isArrayImpl = Array.isArray, REACT_CLIENT_REFERENCE = /* @__PURE__ */ Symbol.for("react.client.reference"), ReactSharedInternals = {
        H: null,
        A: null,
        T: null,
        S: null,
        actQueue: null,
        asyncTransitions: 0,
        isBatchingLegacy: false,
        didScheduleLegacyUpdate: false,
        didUsePromise: false,
        thrownErrors: [],
        getCurrentStack: null,
        recentlyCreatedOwnerStacks: 0
      }, hasOwnProperty = Object.prototype.hasOwnProperty, createTask = console.createTask ? console.createTask : function() {
        return null;
      };
      deprecatedAPIs = {
        react_stack_bottom_frame: function(callStackForError) {
          return callStackForError();
        }
      };
      var specialPropKeyWarningShown, didWarnAboutOldJSXRuntime;
      var didWarnAboutElementRef = {};
      var unknownOwnerDebugStack = deprecatedAPIs.react_stack_bottom_frame.bind(
        deprecatedAPIs,
        UnknownOwner
      )();
      var unknownOwnerDebugTask = createTask(getTaskName(UnknownOwner));
      var didWarnAboutMaps = false, userProvidedKeyEscapeRegex = /\/+/g, reportGlobalError = "function" === typeof reportError ? reportError : function(error) {
        if ("object" === typeof window && "function" === typeof window.ErrorEvent) {
          var event = new window.ErrorEvent("error", {
            bubbles: true,
            cancelable: true,
            message: "object" === typeof error && null !== error && "string" === typeof error.message ? String(error.message) : String(error),
            error
          });
          if (!window.dispatchEvent(event)) return;
        } else if ("object" === typeof process && "function" === typeof process.emit) {
          process.emit("uncaughtException", error);
          return;
        }
        console.error(error);
      }, didWarnAboutMessageChannel = false, enqueueTaskImpl = null, actScopeDepth = 0, didWarnNoAwaitAct = false, isFlushing = false, queueSeveralMicrotasks = "function" === typeof queueMicrotask ? function(callback) {
        queueMicrotask(function() {
          return queueMicrotask(callback);
        });
      } : enqueueTask;
      deprecatedAPIs = Object.freeze({
        __proto__: null,
        c: function(size) {
          return resolveDispatcher().useMemoCache(size);
        }
      });
      var fnName = {
        map: mapChildren,
        forEach: function(children, forEachFunc, forEachContext) {
          mapChildren(
            children,
            function() {
              forEachFunc.apply(this, arguments);
            },
            forEachContext
          );
        },
        count: function(children) {
          var n = 0;
          mapChildren(children, function() {
            n++;
          });
          return n;
        },
        toArray: function(children) {
          return mapChildren(children, function(child) {
            return child;
          }) || [];
        },
        only: function(children) {
          if (!isValidElement(children))
            throw Error(
              "React.Children.only expected to receive a single React element child."
            );
          return children;
        }
      };
      exports.Activity = REACT_ACTIVITY_TYPE;
      exports.Children = fnName;
      exports.Component = Component;
      exports.Fragment = REACT_FRAGMENT_TYPE;
      exports.Profiler = REACT_PROFILER_TYPE;
      exports.PureComponent = PureComponent;
      exports.StrictMode = REACT_STRICT_MODE_TYPE;
      exports.Suspense = REACT_SUSPENSE_TYPE;
      exports.ViewTransition = REACT_VIEW_TRANSITION_TYPE;
      exports.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = ReactSharedInternals;
      exports.__COMPILER_RUNTIME = deprecatedAPIs;
      exports.act = function(callback) {
        var prevActQueue = ReactSharedInternals.actQueue, prevActScopeDepth = actScopeDepth;
        actScopeDepth++;
        var queue = ReactSharedInternals.actQueue = null !== prevActQueue ? prevActQueue : [], didAwaitActCall = false;
        try {
          var result = callback();
        } catch (error) {
          ReactSharedInternals.thrownErrors.push(error);
        }
        if (0 < ReactSharedInternals.thrownErrors.length)
          throw popActScope(prevActQueue, prevActScopeDepth), callback = aggregateErrors(ReactSharedInternals.thrownErrors), ReactSharedInternals.thrownErrors.length = 0, callback;
        if (null !== result && "object" === typeof result && "function" === typeof result.then) {
          var thenable = result;
          queueSeveralMicrotasks(function() {
            didAwaitActCall || didWarnNoAwaitAct || (didWarnNoAwaitAct = true, console.error(
              "You called act(async () => ...) without await. This could lead to unexpected testing behaviour, interleaving multiple act calls and mixing their scopes. You should - await act(async () => ...);"
            ));
          });
          return {
            then: function(resolve, reject) {
              didAwaitActCall = true;
              thenable.then(
                function(returnValue) {
                  popActScope(prevActQueue, prevActScopeDepth);
                  if (0 === prevActScopeDepth) {
                    try {
                      flushActQueue(queue), enqueueTask(function() {
                        return recursivelyFlushAsyncActWork(
                          returnValue,
                          resolve,
                          reject
                        );
                      });
                    } catch (error$0) {
                      ReactSharedInternals.thrownErrors.push(error$0);
                    }
                    if (0 < ReactSharedInternals.thrownErrors.length) {
                      var _thrownError = aggregateErrors(
                        ReactSharedInternals.thrownErrors
                      );
                      ReactSharedInternals.thrownErrors.length = 0;
                      reject(_thrownError);
                    }
                  } else resolve(returnValue);
                },
                function(error) {
                  popActScope(prevActQueue, prevActScopeDepth);
                  0 < ReactSharedInternals.thrownErrors.length ? (error = aggregateErrors(
                    ReactSharedInternals.thrownErrors
                  ), ReactSharedInternals.thrownErrors.length = 0, reject(error)) : reject(error);
                }
              );
            }
          };
        }
        var returnValue$jscomp$0 = result;
        popActScope(prevActQueue, prevActScopeDepth);
        0 === prevActScopeDepth && (flushActQueue(queue), 0 !== queue.length && queueSeveralMicrotasks(function() {
          didAwaitActCall || didWarnNoAwaitAct || (didWarnNoAwaitAct = true, console.error(
            "A component suspended inside an `act` scope, but the `act` call was not awaited. When testing React components that depend on asynchronous data, you must await the result:\n\nawait act(() => ...)"
          ));
        }), ReactSharedInternals.actQueue = null);
        if (0 < ReactSharedInternals.thrownErrors.length)
          throw callback = aggregateErrors(ReactSharedInternals.thrownErrors), ReactSharedInternals.thrownErrors.length = 0, callback;
        return {
          then: function(resolve, reject) {
            didAwaitActCall = true;
            0 === prevActScopeDepth ? (ReactSharedInternals.actQueue = queue, enqueueTask(function() {
              return recursivelyFlushAsyncActWork(
                returnValue$jscomp$0,
                resolve,
                reject
              );
            })) : resolve(returnValue$jscomp$0);
          }
        };
      };
      exports.addTransitionType = addTransitionType;
      exports.cache = function(fn) {
        return function() {
          return fn.apply(null, arguments);
        };
      };
      exports.cacheSignal = function() {
        return null;
      };
      exports.captureOwnerStack = function() {
        var getCurrentStack = ReactSharedInternals.getCurrentStack;
        return null === getCurrentStack ? null : getCurrentStack();
      };
      exports.cloneElement = function(element, config, children) {
        if (null === element || void 0 === element)
          throw Error(
            "The argument must be a React element, but you passed " + element + "."
          );
        var props = assign({}, element.props), key = element.key, owner = element._owner;
        if (null != config) {
          var JSCompiler_inline_result;
          a: {
            if (hasOwnProperty.call(config, "ref") && (JSCompiler_inline_result = Object.getOwnPropertyDescriptor(
              config,
              "ref"
            ).get) && JSCompiler_inline_result.isReactWarning) {
              JSCompiler_inline_result = false;
              break a;
            }
            JSCompiler_inline_result = void 0 !== config.ref;
          }
          JSCompiler_inline_result && (owner = getOwner());
          hasValidKey(config) && (checkKeyStringCoercion(config.key), key = "" + config.key);
          for (propName in config)
            !hasOwnProperty.call(config, propName) || "key" === propName || "__self" === propName || "__source" === propName || "ref" === propName && void 0 === config.ref || (props[propName] = config[propName]);
        }
        var propName = arguments.length - 2;
        if (1 === propName) props.children = children;
        else if (1 < propName) {
          JSCompiler_inline_result = Array(propName);
          for (var i = 0; i < propName; i++)
            JSCompiler_inline_result[i] = arguments[i + 2];
          props.children = JSCompiler_inline_result;
        }
        props = ReactElement(
          element.type,
          key,
          props,
          owner,
          element._debugStack,
          element._debugTask
        );
        for (key = 2; key < arguments.length; key++)
          validateChildKeys(arguments[key]);
        return props;
      };
      exports.createContext = function(defaultValue) {
        defaultValue = {
          $$typeof: REACT_CONTEXT_TYPE,
          _currentValue: defaultValue,
          _currentValue2: defaultValue,
          _threadCount: 0,
          Provider: null,
          Consumer: null
        };
        defaultValue.Provider = defaultValue;
        defaultValue.Consumer = {
          $$typeof: REACT_CONSUMER_TYPE,
          _context: defaultValue
        };
        defaultValue._currentRenderer = null;
        defaultValue._currentRenderer2 = null;
        return defaultValue;
      };
      exports.createElement = function(type, config, children) {
        for (var i = 2; i < arguments.length; i++)
          validateChildKeys(arguments[i]);
        var propName;
        i = {};
        var key = null;
        if (null != config)
          for (propName in didWarnAboutOldJSXRuntime || !("__self" in config) || "key" in config || (didWarnAboutOldJSXRuntime = true, console.warn(
            "Your app (or one of its dependencies) is using an outdated JSX transform. Update to the modern JSX transform for faster performance: https://react.dev/link/new-jsx-transform"
          )), hasValidKey(config) && (checkKeyStringCoercion(config.key), key = "" + config.key), config)
            hasOwnProperty.call(config, propName) && "key" !== propName && "__self" !== propName && "__source" !== propName && (i[propName] = config[propName]);
        var childrenLength = arguments.length - 2;
        if (1 === childrenLength) i.children = children;
        else if (1 < childrenLength) {
          for (var childArray = Array(childrenLength), _i = 0; _i < childrenLength; _i++)
            childArray[_i] = arguments[_i + 2];
          Object.freeze && Object.freeze(childArray);
          i.children = childArray;
        }
        if (type && type.defaultProps)
          for (propName in childrenLength = type.defaultProps, childrenLength)
            void 0 === i[propName] && (i[propName] = childrenLength[propName]);
        key && defineKeyPropWarningGetter(
          i,
          "function" === typeof type ? type.displayName || type.name || "Unknown" : type
        );
        (propName = 1e4 > ReactSharedInternals.recentlyCreatedOwnerStacks++) ? (childArray = Error.stackTraceLimit, Error.stackTraceLimit = 10, childrenLength = Error("react-stack-top-frame"), Error.stackTraceLimit = childArray) : childrenLength = unknownOwnerDebugStack;
        return ReactElement(
          type,
          key,
          i,
          getOwner(),
          childrenLength,
          propName ? createTask(getTaskName(type)) : unknownOwnerDebugTask
        );
      };
      exports.createRef = function() {
        var refObject = { current: null };
        Object.seal(refObject);
        return refObject;
      };
      exports.forwardRef = function(render) {
        null != render && render.$$typeof === REACT_MEMO_TYPE ? console.error(
          "forwardRef requires a render function but received a `memo` component. Instead of forwardRef(memo(...)), use memo(forwardRef(...))."
        ) : "function" !== typeof render ? console.error(
          "forwardRef requires a render function but was given %s.",
          null === render ? "null" : typeof render
        ) : 0 !== render.length && 2 !== render.length && console.error(
          "forwardRef render functions accept exactly two parameters: props and ref. %s",
          1 === render.length ? "Did you forget to use the ref parameter?" : "Any additional parameter will be undefined."
        );
        null != render && null != render.defaultProps && console.error(
          "forwardRef render functions do not support defaultProps. Did you accidentally pass a React component?"
        );
        var elementType = { $$typeof: REACT_FORWARD_REF_TYPE, render }, ownName;
        Object.defineProperty(elementType, "displayName", {
          enumerable: false,
          configurable: true,
          get: function() {
            return ownName;
          },
          set: function(name) {
            ownName = name;
            render.name || render.displayName || (Object.defineProperty(render, "name", { value: name }), render.displayName = name);
          }
        });
        return elementType;
      };
      exports.isValidElement = isValidElement;
      exports.lazy = function(ctor) {
        ctor = { _status: -1, _result: ctor };
        var lazyType = {
          $$typeof: REACT_LAZY_TYPE,
          _payload: ctor,
          _init: lazyInitializer
        }, ioInfo = {
          name: "lazy",
          start: -1,
          end: -1,
          value: null,
          owner: null,
          debugStack: Error("react-stack-top-frame"),
          debugTask: console.createTask ? console.createTask("lazy()") : null
        };
        ctor._ioInfo = ioInfo;
        lazyType._debugInfo = [{ awaited: ioInfo }];
        return lazyType;
      };
      exports.memo = function(type, compare) {
        null == type && console.error(
          "memo: The first argument must be a component. Instead received: %s",
          null === type ? "null" : typeof type
        );
        compare = {
          $$typeof: REACT_MEMO_TYPE,
          type,
          compare: void 0 === compare ? null : compare
        };
        var ownName;
        Object.defineProperty(compare, "displayName", {
          enumerable: false,
          configurable: true,
          get: function() {
            return ownName;
          },
          set: function(name) {
            ownName = name;
            type.name || type.displayName || (Object.defineProperty(type, "name", { value: name }), type.displayName = name);
          }
        });
        return compare;
      };
      exports.startTransition = startTransition;
      exports.unstable_useCacheRefresh = function() {
        return resolveDispatcher().useCacheRefresh();
      };
      exports.use = function(usable) {
        return resolveDispatcher().use(usable);
      };
      exports.useActionState = function(action, initialState, permalink) {
        return resolveDispatcher().useActionState(
          action,
          initialState,
          permalink
        );
      };
      exports.useCallback = function(callback, deps) {
        return resolveDispatcher().useCallback(callback, deps);
      };
      exports.useContext = function(Context) {
        var dispatcher = resolveDispatcher();
        Context.$$typeof === REACT_CONSUMER_TYPE && console.error(
          "Calling useContext(Context.Consumer) is not supported and will cause bugs. Did you mean to call useContext(Context) instead?"
        );
        return dispatcher.useContext(Context);
      };
      exports.useDebugValue = function(value, formatterFn) {
        return resolveDispatcher().useDebugValue(value, formatterFn);
      };
      exports.useDeferredValue = function(value, initialValue) {
        return resolveDispatcher().useDeferredValue(value, initialValue);
      };
      exports.useEffect = function(create, deps) {
        null == create && console.warn(
          "React Hook useEffect requires an effect callback. Did you forget to pass a callback to the hook?"
        );
        return resolveDispatcher().useEffect(create, deps);
      };
      exports.useEffectEvent = function(callback) {
        return resolveDispatcher().useEffectEvent(callback);
      };
      exports.useId = function() {
        return resolveDispatcher().useId();
      };
      exports.useImperativeHandle = function(ref, create, deps) {
        return resolveDispatcher().useImperativeHandle(ref, create, deps);
      };
      exports.useInsertionEffect = function(create, deps) {
        null == create && console.warn(
          "React Hook useInsertionEffect requires an effect callback. Did you forget to pass a callback to the hook?"
        );
        return resolveDispatcher().useInsertionEffect(create, deps);
      };
      exports.useLayoutEffect = function(create, deps) {
        null == create && console.warn(
          "React Hook useLayoutEffect requires an effect callback. Did you forget to pass a callback to the hook?"
        );
        return resolveDispatcher().useLayoutEffect(create, deps);
      };
      exports.useMemo = function(create, deps) {
        return resolveDispatcher().useMemo(create, deps);
      };
      exports.useOptimistic = function(passthrough, reducer) {
        return resolveDispatcher().useOptimistic(passthrough, reducer);
      };
      exports.useReducer = function(reducer, initialArg, init) {
        return resolveDispatcher().useReducer(reducer, initialArg, init);
      };
      exports.useRef = function(initialValue) {
        return resolveDispatcher().useRef(initialValue);
      };
      exports.useState = function(initialState) {
        return resolveDispatcher().useState(initialState);
      };
      exports.useSyncExternalStore = function(subscribe, getSnapshot, getServerSnapshot) {
        return resolveDispatcher().useSyncExternalStore(
          subscribe,
          getSnapshot,
          getServerSnapshot
        );
      };
      exports.useTransition = function() {
        return resolveDispatcher().useTransition();
      };
      exports.version = "19.3.1";
      "undefined" !== typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ && "function" === typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStop && __REACT_DEVTOOLS_GLOBAL_HOOK__.registerInternalModuleStop(Error());
    })();
  }
});

// ../node_modules/.pnpm/react@19.3.1/node_modules/react/index.js
var require_react = __commonJS({
  "../node_modules/.pnpm/react@19.3.1/node_modules/react/index.js"(exports, module) {
    "use strict";
    if (false) {
      module.exports = null;
    } else {
      module.exports = require_react_development();
    }
  }
});

// ../node_modules/.pnpm/react@19.3.1/node_modules/react/cjs/react-jsx-runtime.development.js
var require_react_jsx_runtime_development = __commonJS({
  "../node_modules/.pnpm/react@19.3.1/node_modules/react/cjs/react-jsx-runtime.development.js"(exports) {
    "use strict";
    (function() {
      function getComponentNameFromType(type) {
        if (null == type) return null;
        if ("function" === typeof type)
          return type.$$typeof === REACT_CLIENT_REFERENCE ? null : type.displayName || type.name || null;
        if ("string" === typeof type) return type;
        switch (type) {
          case REACT_FRAGMENT_TYPE:
            return "Fragment";
          case REACT_PROFILER_TYPE:
            return "Profiler";
          case REACT_STRICT_MODE_TYPE:
            return "StrictMode";
          case REACT_SUSPENSE_TYPE:
            return "Suspense";
          case REACT_SUSPENSE_LIST_TYPE:
            return "SuspenseList";
          case REACT_ACTIVITY_TYPE:
            return "Activity";
          case REACT_VIEW_TRANSITION_TYPE:
            return "ViewTransition";
        }
        if ("object" === typeof type)
          switch ("number" === typeof type.tag && console.error(
            "Received an unexpected object in getComponentNameFromType(). This is likely a bug in React. Please file an issue."
          ), type.$$typeof) {
            case REACT_PORTAL_TYPE:
              return "Portal";
            case REACT_CONTEXT_TYPE:
              return type.displayName || "Context";
            case REACT_CONSUMER_TYPE:
              return (type._context.displayName || "Context") + ".Consumer";
            case REACT_FORWARD_REF_TYPE:
              var innerType = type.render;
              type = type.displayName;
              type || (type = innerType.displayName || innerType.name || "", type = "" !== type ? "ForwardRef(" + type + ")" : "ForwardRef");
              return type;
            case REACT_MEMO_TYPE:
              return innerType = type.displayName || null, null !== innerType ? innerType : getComponentNameFromType(type.type) || "Memo";
            case REACT_LAZY_TYPE:
              innerType = type._payload;
              type = type._init;
              try {
                return getComponentNameFromType(type(innerType));
              } catch (x) {
              }
          }
        return null;
      }
      function testStringCoercion(value) {
        return "" + value;
      }
      function checkKeyStringCoercion(value) {
        try {
          testStringCoercion(value);
          var JSCompiler_inline_result = false;
        } catch (e) {
          JSCompiler_inline_result = true;
        }
        if (JSCompiler_inline_result) {
          JSCompiler_inline_result = console;
          var JSCompiler_temp_const = JSCompiler_inline_result.error;
          var JSCompiler_inline_result$jscomp$0 = "function" === typeof Symbol && Symbol.toStringTag && value[Symbol.toStringTag] || value.constructor.name || "Object";
          JSCompiler_temp_const.call(
            JSCompiler_inline_result,
            "The provided key is an unsupported type %s. This value must be coerced to a string before using it here.",
            JSCompiler_inline_result$jscomp$0
          );
          return testStringCoercion(value);
        }
      }
      function getTaskName(type) {
        if (type === REACT_FRAGMENT_TYPE) return "<>";
        if ("object" === typeof type && null !== type && type.$$typeof === REACT_LAZY_TYPE)
          return "<...>";
        try {
          var name = getComponentNameFromType(type);
          return name ? "<" + name + ">" : "<...>";
        } catch (x) {
          return "<...>";
        }
      }
      function getOwner() {
        var dispatcher = ReactSharedInternals.A;
        return null === dispatcher ? null : dispatcher.getOwner();
      }
      function UnknownOwner() {
        return Error("react-stack-top-frame");
      }
      function hasValidKey(config) {
        if (hasOwnProperty.call(config, "key")) {
          var getter = Object.getOwnPropertyDescriptor(config, "key").get;
          if (getter && getter.isReactWarning) return false;
        }
        return void 0 !== config.key;
      }
      function defineKeyPropWarningGetter(props, displayName) {
        function warnAboutAccessingKey() {
          specialPropKeyWarningShown || (specialPropKeyWarningShown = true, console.error(
            "%s: `key` is not a prop. Trying to access it will result in `undefined` being returned. If you need to access the same value within the child component, you should pass it as a different prop. (https://react.dev/link/special-props)",
            displayName
          ));
        }
        warnAboutAccessingKey.isReactWarning = true;
        Object.defineProperty(props, "key", {
          get: warnAboutAccessingKey,
          configurable: true
        });
      }
      function elementRefGetterWithDeprecationWarning() {
        var componentName = getComponentNameFromType(this.type);
        didWarnAboutElementRef[componentName] || (didWarnAboutElementRef[componentName] = true, console.error(
          "Accessing element.ref was removed in React 19. ref is now a regular prop. It will be removed from the JSX Element type in a future release."
        ));
        componentName = this.props.ref;
        return void 0 !== componentName ? componentName : null;
      }
      function ReactElement(type, key, props, owner, debugStack, debugTask) {
        var refProp = props.ref;
        type = {
          $$typeof: REACT_ELEMENT_TYPE,
          type,
          key,
          props,
          _owner: owner
        };
        null !== (void 0 !== refProp ? refProp : null) ? Object.defineProperty(type, "ref", {
          enumerable: false,
          get: elementRefGetterWithDeprecationWarning
        }) : Object.defineProperty(type, "ref", { enumerable: false, value: null });
        type._store = {};
        Object.defineProperty(type._store, "validated", {
          configurable: false,
          enumerable: false,
          writable: true,
          value: 0
        });
        Object.defineProperty(type, "_debugInfo", {
          configurable: false,
          enumerable: false,
          writable: true,
          value: null
        });
        Object.defineProperty(type, "_debugStack", {
          configurable: false,
          enumerable: false,
          writable: true,
          value: debugStack
        });
        Object.defineProperty(type, "_debugTask", {
          configurable: false,
          enumerable: false,
          writable: true,
          value: debugTask
        });
        Object.freeze && (Object.freeze(type.props), Object.freeze(type));
        return type;
      }
      function jsxDEVImpl(type, config, maybeKey, isStaticChildren, debugStack, debugTask) {
        var children = config.children;
        if (void 0 !== children)
          if (isStaticChildren)
            if (isArrayImpl(children)) {
              for (isStaticChildren = 0; isStaticChildren < children.length; isStaticChildren++)
                validateChildKeys(children[isStaticChildren]);
              Object.freeze && Object.freeze(children);
            } else
              console.error(
                "React.jsx: Static children should always be an array. You are likely explicitly calling React.jsxs or React.jsxDEV. Use the Babel transform instead."
              );
          else validateChildKeys(children);
        if (hasOwnProperty.call(config, "key")) {
          children = getComponentNameFromType(type);
          var keys = Object.keys(config).filter(function(k) {
            return "key" !== k;
          });
          isStaticChildren = 0 < keys.length ? "{key: someKey, " + keys.join(": ..., ") + ": ...}" : "{key: someKey}";
          didWarnAboutKeySpread[children + isStaticChildren] || (keys = 0 < keys.length ? "{" + keys.join(": ..., ") + ": ...}" : "{}", console.error(
            'A props object containing a "key" prop is being spread into JSX:\n  let props = %s;\n  <%s {...props} />\nReact keys must be passed directly to JSX without using spread:\n  let props = %s;\n  <%s key={someKey} {...props} />',
            isStaticChildren,
            children,
            keys,
            children
          ), didWarnAboutKeySpread[children + isStaticChildren] = true);
        }
        children = null;
        void 0 !== maybeKey && (checkKeyStringCoercion(maybeKey), children = "" + maybeKey);
        hasValidKey(config) && (checkKeyStringCoercion(config.key), children = "" + config.key);
        if ("key" in config) {
          maybeKey = {};
          for (var propName in config)
            "key" !== propName && (maybeKey[propName] = config[propName]);
        } else maybeKey = config;
        children && defineKeyPropWarningGetter(
          maybeKey,
          "function" === typeof type ? type.displayName || type.name || "Unknown" : type
        );
        return ReactElement(
          type,
          children,
          maybeKey,
          getOwner(),
          debugStack,
          debugTask
        );
      }
      function validateChildKeys(node) {
        isValidElement(node) ? node._store && (node._store.validated = 1) : "object" === typeof node && null !== node && node.$$typeof === REACT_LAZY_TYPE && ("fulfilled" === node._payload.status ? isValidElement(node._payload.value) && node._payload.value._store && (node._payload.value._store.validated = 1) : node._store && (node._store.validated = 1));
      }
      function isValidElement(object) {
        return "object" === typeof object && null !== object && object.$$typeof === REACT_ELEMENT_TYPE;
      }
      var React = require_react(), REACT_ELEMENT_TYPE = /* @__PURE__ */ Symbol.for("react.transitional.element"), REACT_PORTAL_TYPE = /* @__PURE__ */ Symbol.for("react.portal"), REACT_FRAGMENT_TYPE = /* @__PURE__ */ Symbol.for("react.fragment"), REACT_STRICT_MODE_TYPE = /* @__PURE__ */ Symbol.for("react.strict_mode"), REACT_PROFILER_TYPE = /* @__PURE__ */ Symbol.for("react.profiler"), REACT_CONSUMER_TYPE = /* @__PURE__ */ Symbol.for("react.consumer"), REACT_CONTEXT_TYPE = /* @__PURE__ */ Symbol.for("react.context"), REACT_FORWARD_REF_TYPE = /* @__PURE__ */ Symbol.for("react.forward_ref"), REACT_SUSPENSE_TYPE = /* @__PURE__ */ Symbol.for("react.suspense"), REACT_SUSPENSE_LIST_TYPE = /* @__PURE__ */ Symbol.for("react.suspense_list"), REACT_MEMO_TYPE = /* @__PURE__ */ Symbol.for("react.memo"), REACT_LAZY_TYPE = /* @__PURE__ */ Symbol.for("react.lazy"), REACT_ACTIVITY_TYPE = /* @__PURE__ */ Symbol.for("react.activity"), REACT_VIEW_TRANSITION_TYPE = /* @__PURE__ */ Symbol.for("react.view_transition"), REACT_CLIENT_REFERENCE = /* @__PURE__ */ Symbol.for("react.client.reference"), ReactSharedInternals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE, hasOwnProperty = Object.prototype.hasOwnProperty, isArrayImpl = Array.isArray, createTask = console.createTask ? console.createTask : function() {
        return null;
      };
      React = {
        react_stack_bottom_frame: function(callStackForError) {
          return callStackForError();
        }
      };
      var specialPropKeyWarningShown;
      var didWarnAboutElementRef = {};
      var unknownOwnerDebugStack = React.react_stack_bottom_frame.bind(
        React,
        UnknownOwner
      )();
      var unknownOwnerDebugTask = createTask(getTaskName(UnknownOwner));
      var didWarnAboutKeySpread = {};
      exports.Fragment = REACT_FRAGMENT_TYPE;
      exports.jsx = function(type, config, maybeKey) {
        var trackActualOwner = 1e4 > ReactSharedInternals.recentlyCreatedOwnerStacks++;
        if (trackActualOwner) {
          var previousStackTraceLimit = Error.stackTraceLimit;
          Error.stackTraceLimit = 10;
          var debugStackDEV = Error("react-stack-top-frame");
          Error.stackTraceLimit = previousStackTraceLimit;
        } else debugStackDEV = unknownOwnerDebugStack;
        return jsxDEVImpl(
          type,
          config,
          maybeKey,
          false,
          debugStackDEV,
          trackActualOwner ? createTask(getTaskName(type)) : unknownOwnerDebugTask
        );
      };
      exports.jsxs = function(type, config, maybeKey) {
        var trackActualOwner = 1e4 > ReactSharedInternals.recentlyCreatedOwnerStacks++;
        if (trackActualOwner) {
          var previousStackTraceLimit = Error.stackTraceLimit;
          Error.stackTraceLimit = 10;
          var debugStackDEV = Error("react-stack-top-frame");
          Error.stackTraceLimit = previousStackTraceLimit;
        } else debugStackDEV = unknownOwnerDebugStack;
        return jsxDEVImpl(
          type,
          config,
          maybeKey,
          true,
          debugStackDEV,
          trackActualOwner ? createTask(getTaskName(type)) : unknownOwnerDebugTask
        );
      };
    })();
  }
});

// ../node_modules/.pnpm/react@19.3.1/node_modules/react/jsx-runtime.js
var require_jsx_runtime = __commonJS({
  "../node_modules/.pnpm/react@19.3.1/node_modules/react/jsx-runtime.js"(exports, module) {
    "use strict";
    if (false) {
      module.exports = null;
    } else {
      module.exports = require_react_jsx_runtime_development();
    }
  }
});

// ../node_modules/.pnpm/jssha@3.3.2/node_modules/jssha/dist/sha.js
var require_sha = __commonJS({
  "../node_modules/.pnpm/jssha@3.3.2/node_modules/jssha/dist/sha.js"(exports, module) {
    !(function(n, r) {
      "object" == typeof exports && "undefined" != typeof module ? module.exports = r() : "function" == typeof define && define.amd ? define(r) : (n = "undefined" != typeof globalThis ? globalThis : n || self).jsSHA = r();
    })(exports, function() {
      "use strict";
      var n = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", r = "ARRAYBUFFER not supported by this environment", t = "UINT8ARRAY not supported by this environment";
      function e(n2, r2, t2, e2) {
        var i2, o2, u2, f2 = r2 || [0], s2 = (t2 = t2 || 0) >>> 3, w2 = -1 === e2 ? 3 : 0;
        for (i2 = 0; i2 < n2.length; i2 += 1) o2 = (u2 = i2 + s2) >>> 2, f2.length <= o2 && f2.push(0), f2[o2] |= n2[i2] << 8 * (w2 + e2 * (u2 % 4));
        return { value: f2, binLen: 8 * n2.length + t2 };
      }
      function i(i2, o2, u2) {
        switch (o2) {
          case "UTF8":
          case "UTF16BE":
          case "UTF16LE":
            break;
          default:
            throw new Error("encoding must be UTF8, UTF16BE, or UTF16LE");
        }
        switch (i2) {
          case "HEX":
            return function(n2, r2, t2) {
              return (function(n3, r3, t3, e2) {
                var i3, o3, u3, f2;
                if (0 != n3.length % 2) throw new Error("String of HEX type must be in byte increments");
                var s2 = r3 || [0], w2 = (t3 = t3 || 0) >>> 3, a2 = -1 === e2 ? 3 : 0;
                for (i3 = 0; i3 < n3.length; i3 += 2) {
                  if (o3 = parseInt(n3.substr(i3, 2), 16), isNaN(o3)) throw new Error("String of HEX type contains invalid characters");
                  for (u3 = (f2 = (i3 >>> 1) + w2) >>> 2; s2.length <= u3; ) s2.push(0);
                  s2[u3] |= o3 << 8 * (a2 + e2 * (f2 % 4));
                }
                return { value: s2, binLen: 4 * n3.length + t3 };
              })(n2, r2, t2, u2);
            };
          case "TEXT":
            return function(n2, r2, t2) {
              return (function(n3, r3, t3, e2, i3) {
                var o3, u3, f2, s2, w2, a2, h2, c2, v2 = 0, A2 = t3 || [0], E2 = (e2 = e2 || 0) >>> 3;
                if ("UTF8" === r3) for (h2 = -1 === i3 ? 3 : 0, f2 = 0; f2 < n3.length; f2 += 1) for (u3 = [], 128 > (o3 = n3.charCodeAt(f2)) ? u3.push(o3) : 2048 > o3 ? (u3.push(192 | o3 >>> 6), u3.push(128 | 63 & o3)) : 55296 > o3 || 57344 <= o3 ? u3.push(224 | o3 >>> 12, 128 | o3 >>> 6 & 63, 128 | 63 & o3) : (f2 += 1, o3 = 65536 + ((1023 & o3) << 10 | 1023 & n3.charCodeAt(f2)), u3.push(240 | o3 >>> 18, 128 | o3 >>> 12 & 63, 128 | o3 >>> 6 & 63, 128 | 63 & o3)), s2 = 0; s2 < u3.length; s2 += 1) {
                  for (w2 = (a2 = v2 + E2) >>> 2; A2.length <= w2; ) A2.push(0);
                  A2[w2] |= u3[s2] << 8 * (h2 + i3 * (a2 % 4)), v2 += 1;
                }
                else for (h2 = -1 === i3 ? 2 : 0, c2 = "UTF16LE" === r3 && 1 !== i3 || "UTF16LE" !== r3 && 1 === i3, f2 = 0; f2 < n3.length; f2 += 1) {
                  for (o3 = n3.charCodeAt(f2), true === c2 && (o3 = (s2 = 255 & o3) << 8 | o3 >>> 8), w2 = (a2 = v2 + E2) >>> 2; A2.length <= w2; ) A2.push(0);
                  A2[w2] |= o3 << 8 * (h2 + i3 * (a2 % 4)), v2 += 2;
                }
                return { value: A2, binLen: 8 * v2 + e2 };
              })(n2, o2, r2, t2, u2);
            };
          case "B64":
            return function(r2, t2, e2) {
              return (function(r3, t3, e3, i3) {
                var o3, u3, f2, s2, w2, a2, h2 = 0, c2 = t3 || [0], v2 = (e3 = e3 || 0) >>> 3, A2 = -1 === i3 ? 3 : 0, E2 = r3.indexOf("=");
                if (-1 === r3.search(/^[a-zA-Z0-9=+/]+$/)) throw new Error("Invalid character in base-64 string");
                if (r3 = r3.replace(/=/g, ""), -1 !== E2 && E2 < r3.length) throw new Error("Invalid '=' found in base-64 string");
                for (o3 = 0; o3 < r3.length; o3 += 4) {
                  for (s2 = r3.substr(o3, 4), f2 = 0, u3 = 0; u3 < s2.length; u3 += 1) f2 |= n.indexOf(s2.charAt(u3)) << 18 - 6 * u3;
                  for (u3 = 0; u3 < s2.length - 1; u3 += 1) {
                    for (w2 = (a2 = h2 + v2) >>> 2; c2.length <= w2; ) c2.push(0);
                    c2[w2] |= (f2 >>> 16 - 8 * u3 & 255) << 8 * (A2 + i3 * (a2 % 4)), h2 += 1;
                  }
                }
                return { value: c2, binLen: 8 * h2 + e3 };
              })(r2, t2, e2, u2);
            };
          case "BYTES":
            return function(n2, r2, t2) {
              return (function(n3, r3, t3, e2) {
                var i3, o3, u3, f2, s2 = r3 || [0], w2 = (t3 = t3 || 0) >>> 3, a2 = -1 === e2 ? 3 : 0;
                for (o3 = 0; o3 < n3.length; o3 += 1) i3 = n3.charCodeAt(o3), u3 = (f2 = o3 + w2) >>> 2, s2.length <= u3 && s2.push(0), s2[u3] |= i3 << 8 * (a2 + e2 * (f2 % 4));
                return { value: s2, binLen: 8 * n3.length + t3 };
              })(n2, r2, t2, u2);
            };
          case "ARRAYBUFFER":
            try {
              new ArrayBuffer(0);
            } catch (n2) {
              throw new Error(r);
            }
            return function(n2, r2, t2) {
              return (function(n3, r3, t3, i3) {
                return e(new Uint8Array(n3), r3, t3, i3);
              })(n2, r2, t2, u2);
            };
          case "UINT8ARRAY":
            try {
              new Uint8Array(0);
            } catch (n2) {
              throw new Error(t);
            }
            return function(n2, r2, t2) {
              return e(n2, r2, t2, u2);
            };
          default:
            throw new Error("format must be HEX, TEXT, B64, BYTES, ARRAYBUFFER, or UINT8ARRAY");
        }
      }
      function o(e2, i2, o2, u2) {
        switch (e2) {
          case "HEX":
            return function(n2) {
              return (function(n3, r2, t2, e3) {
                var i3, o3, u3 = "0123456789abcdef", f2 = "", s2 = r2 / 8, w2 = -1 === t2 ? 3 : 0;
                for (i3 = 0; i3 < s2; i3 += 1) o3 = n3[i3 >>> 2] >>> 8 * (w2 + t2 * (i3 % 4)), f2 += u3.charAt(o3 >>> 4 & 15) + u3.charAt(15 & o3);
                return e3.outputUpper ? f2.toUpperCase() : f2;
              })(n2, i2, o2, u2);
            };
          case "B64":
            return function(r2) {
              return (function(r3, t2, e3, i3) {
                var o3, u3, f2, s2, w2, a2 = "", h2 = t2 / 8, c2 = -1 === e3 ? 3 : 0;
                for (o3 = 0; o3 < h2; o3 += 3) for (s2 = o3 + 1 < h2 ? r3[o3 + 1 >>> 2] : 0, w2 = o3 + 2 < h2 ? r3[o3 + 2 >>> 2] : 0, f2 = (r3[o3 >>> 2] >>> 8 * (c2 + e3 * (o3 % 4)) & 255) << 16 | (s2 >>> 8 * (c2 + e3 * ((o3 + 1) % 4)) & 255) << 8 | w2 >>> 8 * (c2 + e3 * ((o3 + 2) % 4)) & 255, u3 = 0; u3 < 4; u3 += 1) a2 += 8 * o3 + 6 * u3 <= t2 ? n.charAt(f2 >>> 6 * (3 - u3) & 63) : i3.b64Pad;
                return a2;
              })(r2, i2, o2, u2);
            };
          case "BYTES":
            return function(n2) {
              return (function(n3, r2, t2) {
                var e3, i3, o3 = "", u3 = r2 / 8, f2 = -1 === t2 ? 3 : 0;
                for (e3 = 0; e3 < u3; e3 += 1) i3 = n3[e3 >>> 2] >>> 8 * (f2 + t2 * (e3 % 4)) & 255, o3 += String.fromCharCode(i3);
                return o3;
              })(n2, i2, o2);
            };
          case "ARRAYBUFFER":
            try {
              new ArrayBuffer(0);
            } catch (n2) {
              throw new Error(r);
            }
            return function(n2) {
              return (function(n3, r2, t2) {
                var e3, i3 = r2 / 8, o3 = new ArrayBuffer(i3), u3 = new Uint8Array(o3), f2 = -1 === t2 ? 3 : 0;
                for (e3 = 0; e3 < i3; e3 += 1) u3[e3] = n3[e3 >>> 2] >>> 8 * (f2 + t2 * (e3 % 4)) & 255;
                return o3;
              })(n2, i2, o2);
            };
          case "UINT8ARRAY":
            try {
              new Uint8Array(0);
            } catch (n2) {
              throw new Error(t);
            }
            return function(n2) {
              return (function(n3, r2, t2) {
                var e3, i3 = r2 / 8, o3 = -1 === t2 ? 3 : 0, u3 = new Uint8Array(i3);
                for (e3 = 0; e3 < i3; e3 += 1) u3[e3] = n3[e3 >>> 2] >>> 8 * (o3 + t2 * (e3 % 4)) & 255;
                return u3;
              })(n2, i2, o2);
            };
          default:
            throw new Error("format must be HEX, B64, BYTES, ARRAYBUFFER, or UINT8ARRAY");
        }
      }
      var u = 4294967296, f = [1116352408, 1899447441, 3049323471, 3921009573, 961987163, 1508970993, 2453635748, 2870763221, 3624381080, 310598401, 607225278, 1426881987, 1925078388, 2162078206, 2614888103, 3248222580, 3835390401, 4022224774, 264347078, 604807628, 770255983, 1249150122, 1555081692, 1996064986, 2554220882, 2821834349, 2952996808, 3210313671, 3336571891, 3584528711, 113926993, 338241895, 666307205, 773529912, 1294757372, 1396182291, 1695183700, 1986661051, 2177026350, 2456956037, 2730485921, 2820302411, 3259730800, 3345764771, 3516065817, 3600352804, 4094571909, 275423344, 430227734, 506948616, 659060556, 883997877, 958139571, 1322822218, 1537002063, 1747873779, 1955562222, 2024104815, 2227730452, 2361852424, 2428436474, 2756734187, 3204031479, 3329325298], s = [3238371032, 914150663, 812702999, 4144912697, 4290775857, 1750603025, 1694076839, 3204075428], w = [1779033703, 3144134277, 1013904242, 2773480762, 1359893119, 2600822924, 528734635, 1541459225], a = "Chosen SHA variant is not supported", h = "Cannot set numRounds with MAC";
      function c(n2, r2) {
        var t2, e2, i2 = n2.binLen >>> 3, o2 = r2.binLen >>> 3, u2 = i2 << 3, f2 = 4 - i2 << 3;
        if (i2 % 4 != 0) {
          for (t2 = 0; t2 < o2; t2 += 4) e2 = i2 + t2 >>> 2, n2.value[e2] |= r2.value[t2 >>> 2] << u2, n2.value.push(0), n2.value[e2 + 1] |= r2.value[t2 >>> 2] >>> f2;
          return (n2.value.length << 2) - 4 >= o2 + i2 && n2.value.pop(), { value: n2.value, binLen: n2.binLen + r2.binLen };
        }
        return { value: n2.value.concat(r2.value), binLen: n2.binLen + r2.binLen };
      }
      function v(n2) {
        var r2 = { outputUpper: false, b64Pad: "=", outputLen: -1 }, t2 = n2 || {}, e2 = "Output length must be a multiple of 8";
        if (r2.outputUpper = t2.outputUpper || false, t2.b64Pad && (r2.b64Pad = t2.b64Pad), t2.outputLen) {
          if (t2.outputLen % 8 != 0) throw new Error(e2);
          r2.outputLen = t2.outputLen;
        } else if (t2.shakeLen) {
          if (t2.shakeLen % 8 != 0) throw new Error(e2);
          r2.outputLen = t2.shakeLen;
        }
        if ("boolean" != typeof r2.outputUpper) throw new Error("Invalid outputUpper formatting option");
        if ("string" != typeof r2.b64Pad) throw new Error("Invalid b64Pad formatting option");
        return r2;
      }
      function A(n2, r2, t2, e2) {
        var o2 = n2 + " must include a value and format";
        if (!r2) {
          if (!e2) throw new Error(o2);
          return e2;
        }
        if (void 0 === r2.value || !r2.format) throw new Error(o2);
        return i(r2.format, r2.encoding || "UTF8", t2)(r2.value);
      }
      var E = (function() {
        function n2(n3, r2, t2) {
          var e2 = t2 || {};
          if (this.t = r2, this.i = e2.encoding || "UTF8", this.numRounds = e2.numRounds || 1, isNaN(this.numRounds) || this.numRounds !== parseInt(this.numRounds, 10) || 1 > this.numRounds) throw new Error("numRounds must a integer >= 1");
          this.o = n3, this.u = [], this.h = 0, this.v = false, this.A = 0, this.l = false, this.S = [], this.H = [];
        }
        return n2.prototype.update = function(n3) {
          var r2, t2 = 0, e2 = this.p >>> 5, i2 = this.m(n3, this.u, this.h), o2 = i2.binLen, u2 = i2.value, f2 = o2 >>> 5;
          for (r2 = 0; r2 < f2; r2 += e2) t2 + this.p <= o2 && (this.U = this.R(u2.slice(r2, r2 + e2), this.U), t2 += this.p);
          return this.A += t2, this.u = u2.slice(t2 >>> 5), this.h = o2 % this.p, this.v = true, this;
        }, n2.prototype.getHash = function(n3, r2) {
          var t2, e2, i2 = this.T, u2 = v(r2);
          if (this.C) {
            if (-1 === u2.outputLen) throw new Error("Output length must be specified in options");
            i2 = u2.outputLen;
          }
          var f2 = o(n3, i2, this.F, u2);
          if (this.l && this.K) return f2(this.K(u2));
          for (e2 = this.L(this.u.slice(), this.h, this.A, this.B(this.U), i2), t2 = 1; t2 < this.numRounds; t2 += 1) this.C && i2 % 32 != 0 && (e2[e2.length - 1] &= 16777215 >>> 24 - i2 % 32), e2 = this.L(e2, i2, 0, this.k(this.o), i2);
          return f2(e2);
        }, n2.prototype.setHMACKey = function(n3, r2, t2) {
          if (!this.Y) throw new Error("Variant does not support HMAC");
          if (this.v) throw new Error("Cannot set MAC key after calling update");
          var e2 = i(r2, (t2 || {}).encoding || "UTF8", this.F);
          this.N(e2(n3));
        }, n2.prototype.N = function(n3) {
          var r2, t2 = this.p >>> 3, e2 = t2 / 4 - 1;
          if (1 !== this.numRounds) throw new Error(h);
          if (this.l) throw new Error("MAC key already set");
          for (t2 < n3.binLen / 8 && (n3.value = this.L(n3.value, n3.binLen, 0, this.k(this.o), this.T)); n3.value.length <= e2; ) n3.value.push(0);
          for (r2 = 0; r2 <= e2; r2 += 1) this.S[r2] = 909522486 ^ n3.value[r2], this.H[r2] = 1549556828 ^ n3.value[r2];
          this.U = this.R(this.S, this.U), this.A = this.p, this.l = true;
        }, n2.prototype.getHMAC = function(n3, r2) {
          var t2 = v(r2);
          return o(n3, this.T, this.F, t2)(this.I());
        }, n2.prototype.I = function() {
          var n3;
          if (!this.l) throw new Error("Cannot call getHMAC without first setting MAC key");
          var r2 = this.L(this.u.slice(), this.h, this.A, this.B(this.U), this.T);
          return n3 = this.R(this.H, this.k(this.o)), n3 = this.L(r2, this.T, this.p, n3, this.T);
        }, n2;
      })(), l = function(n2, r2) {
        return l = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(n3, r3) {
          n3.__proto__ = r3;
        } || function(n3, r3) {
          for (var t2 in r3) Object.prototype.hasOwnProperty.call(r3, t2) && (n3[t2] = r3[t2]);
        }, l(n2, r2);
      };
      function b(n2, r2) {
        if ("function" != typeof r2 && null !== r2) throw new TypeError("Class extends value " + String(r2) + " is not a constructor or null");
        function t2() {
          this.constructor = n2;
        }
        l(n2, r2), n2.prototype = null === r2 ? Object.create(r2) : (t2.prototype = r2.prototype, new t2());
      }
      function S(n2, r2) {
        return n2 << r2 | n2 >>> 32 - r2;
      }
      function H(n2, r2) {
        return n2 >>> r2 | n2 << 32 - r2;
      }
      function p(n2, r2) {
        return n2 >>> r2;
      }
      function d(n2, r2, t2) {
        return n2 ^ r2 ^ t2;
      }
      function y(n2, r2, t2) {
        return n2 & r2 ^ ~n2 & t2;
      }
      function m(n2, r2, t2) {
        return n2 & r2 ^ n2 & t2 ^ r2 & t2;
      }
      function U(n2) {
        return H(n2, 2) ^ H(n2, 13) ^ H(n2, 22);
      }
      function R(n2, r2) {
        var t2 = (65535 & n2) + (65535 & r2);
        return (65535 & (n2 >>> 16) + (r2 >>> 16) + (t2 >>> 16)) << 16 | 65535 & t2;
      }
      function T(n2, r2, t2, e2) {
        var i2 = (65535 & n2) + (65535 & r2) + (65535 & t2) + (65535 & e2);
        return (65535 & (n2 >>> 16) + (r2 >>> 16) + (t2 >>> 16) + (e2 >>> 16) + (i2 >>> 16)) << 16 | 65535 & i2;
      }
      function C(n2, r2, t2, e2, i2) {
        var o2 = (65535 & n2) + (65535 & r2) + (65535 & t2) + (65535 & e2) + (65535 & i2);
        return (65535 & (n2 >>> 16) + (r2 >>> 16) + (t2 >>> 16) + (e2 >>> 16) + (i2 >>> 16) + (o2 >>> 16)) << 16 | 65535 & o2;
      }
      function F(n2) {
        return H(n2, 17) ^ H(n2, 19) ^ p(n2, 10);
      }
      function K(n2) {
        return H(n2, 7) ^ H(n2, 18) ^ p(n2, 3);
      }
      function g(n2) {
        return H(n2, 6) ^ H(n2, 11) ^ H(n2, 25);
      }
      function L(n2) {
        return [1732584193, 4023233417, 2562383102, 271733878, 3285377520];
      }
      function B(n2, r2) {
        var t2, e2, i2, o2, u2, f2, s2, w2 = [];
        for (t2 = r2[0], e2 = r2[1], i2 = r2[2], o2 = r2[3], u2 = r2[4], s2 = 0; s2 < 80; s2 += 1) w2[s2] = s2 < 16 ? n2[s2] : S(w2[s2 - 3] ^ w2[s2 - 8] ^ w2[s2 - 14] ^ w2[s2 - 16], 1), f2 = s2 < 20 ? C(S(t2, 5), y(e2, i2, o2), u2, 1518500249, w2[s2]) : s2 < 40 ? C(S(t2, 5), d(e2, i2, o2), u2, 1859775393, w2[s2]) : s2 < 60 ? C(S(t2, 5), m(e2, i2, o2), u2, 2400959708, w2[s2]) : C(S(t2, 5), d(e2, i2, o2), u2, 3395469782, w2[s2]), u2 = o2, o2 = i2, i2 = S(e2, 30), e2 = t2, t2 = f2;
        return r2[0] = R(t2, r2[0]), r2[1] = R(e2, r2[1]), r2[2] = R(i2, r2[2]), r2[3] = R(o2, r2[3]), r2[4] = R(u2, r2[4]), r2;
      }
      function k(n2, r2, t2, e2) {
        for (var i2, o2 = 15 + (r2 + 65 >>> 9 << 4), f2 = r2 + t2; n2.length <= o2; ) n2.push(0);
        for (n2[r2 >>> 5] |= 128 << 24 - r2 % 32, n2[o2] = 4294967295 & f2, n2[o2 - 1] = f2 / u | 0, i2 = 0; i2 < n2.length; i2 += 16) e2 = B(n2.slice(i2, i2 + 16), e2);
        return e2;
      }
      "function" == typeof SuppressedError && SuppressedError;
      var Y = (function(n2) {
        function r2(r3, t2, e2) {
          var o2 = this;
          if ("SHA-1" !== r3) throw new Error(a);
          var u2 = e2 || {};
          return (o2 = n2.call(this, r3, t2, e2) || this).Y = true, o2.K = o2.I, o2.F = -1, o2.m = i(o2.t, o2.i, o2.F), o2.R = B, o2.B = function(n3) {
            return n3.slice();
          }, o2.k = L, o2.L = k, o2.U = [1732584193, 4023233417, 2562383102, 271733878, 3285377520], o2.p = 512, o2.T = 160, o2.C = false, u2.hmacKey && o2.N(A("hmacKey", u2.hmacKey, o2.F)), o2;
        }
        return b(r2, n2), r2;
      })(E);
      function N(n2) {
        return "SHA-224" == n2 ? s.slice() : w.slice();
      }
      function I(n2, r2) {
        var t2, e2, i2, o2, u2, s2, w2, a2, h2, c2, v2, A2 = [];
        for (t2 = r2[0], e2 = r2[1], i2 = r2[2], o2 = r2[3], u2 = r2[4], s2 = r2[5], w2 = r2[6], a2 = r2[7], v2 = 0; v2 < 64; v2 += 1) A2[v2] = v2 < 16 ? n2[v2] : T(F(A2[v2 - 2]), A2[v2 - 7], K(A2[v2 - 15]), A2[v2 - 16]), h2 = C(a2, g(u2), y(u2, s2, w2), f[v2], A2[v2]), c2 = R(U(t2), m(t2, e2, i2)), a2 = w2, w2 = s2, s2 = u2, u2 = R(o2, h2), o2 = i2, i2 = e2, e2 = t2, t2 = R(h2, c2);
        return r2[0] = R(t2, r2[0]), r2[1] = R(e2, r2[1]), r2[2] = R(i2, r2[2]), r2[3] = R(o2, r2[3]), r2[4] = R(u2, r2[4]), r2[5] = R(s2, r2[5]), r2[6] = R(w2, r2[6]), r2[7] = R(a2, r2[7]), r2;
      }
      var M = (function(n2) {
        function r2(r3, t2, e2) {
          var o2 = this;
          if ("SHA-224" !== r3 && "SHA-256" !== r3) throw new Error(a);
          var f2 = e2 || {};
          return (o2 = n2.call(this, r3, t2, e2) || this).K = o2.I, o2.Y = true, o2.F = -1, o2.m = i(o2.t, o2.i, o2.F), o2.R = I, o2.B = function(n3) {
            return n3.slice();
          }, o2.k = N, o2.L = function(n3, t3, e3, i2) {
            return (function(n4, r4, t4, e4, i3) {
              for (var o3, f3 = 15 + (r4 + 65 >>> 9 << 4), s2 = r4 + t4; n4.length <= f3; ) n4.push(0);
              for (n4[r4 >>> 5] |= 128 << 24 - r4 % 32, n4[f3] = 4294967295 & s2, n4[f3 - 1] = s2 / u | 0, o3 = 0; o3 < n4.length; o3 += 16) e4 = I(n4.slice(o3, o3 + 16), e4);
              return "SHA-224" === i3 ? [e4[0], e4[1], e4[2], e4[3], e4[4], e4[5], e4[6]] : e4;
            })(n3, t3, e3, i2, r3);
          }, o2.U = N(r3), o2.p = 512, o2.T = "SHA-224" === r3 ? 224 : 256, o2.C = false, f2.hmacKey && o2.N(A("hmacKey", f2.hmacKey, o2.F)), o2;
        }
        return b(r2, n2), r2;
      })(E), X = function(n2, r2) {
        this.M = n2, this.X = r2;
      };
      function z(n2, r2) {
        var t2;
        return r2 > 32 ? (t2 = 64 - r2, new X(n2.X << r2 | n2.M >>> t2, n2.M << r2 | n2.X >>> t2)) : 0 !== r2 ? (t2 = 32 - r2, new X(n2.M << r2 | n2.X >>> t2, n2.X << r2 | n2.M >>> t2)) : n2;
      }
      function O(n2, r2) {
        var t2;
        return r2 < 32 ? (t2 = 32 - r2, new X(n2.M >>> r2 | n2.X << t2, n2.X >>> r2 | n2.M << t2)) : (t2 = 64 - r2, new X(n2.X >>> r2 | n2.M << t2, n2.M >>> r2 | n2.X << t2));
      }
      function j(n2, r2) {
        return new X(n2.M >>> r2, n2.X >>> r2 | n2.M << 32 - r2);
      }
      function _(n2, r2, t2) {
        return new X(n2.M & r2.M ^ ~n2.M & t2.M, n2.X & r2.X ^ ~n2.X & t2.X);
      }
      function x(n2, r2, t2) {
        return new X(n2.M & r2.M ^ n2.M & t2.M ^ r2.M & t2.M, n2.X & r2.X ^ n2.X & t2.X ^ r2.X & t2.X);
      }
      function P(n2) {
        var r2 = O(n2, 28), t2 = O(n2, 34), e2 = O(n2, 39);
        return new X(r2.M ^ t2.M ^ e2.M, r2.X ^ t2.X ^ e2.X);
      }
      function V(n2, r2) {
        var t2, e2;
        t2 = (65535 & n2.X) + (65535 & r2.X);
        var i2 = (65535 & (e2 = (n2.X >>> 16) + (r2.X >>> 16) + (t2 >>> 16))) << 16 | 65535 & t2;
        return t2 = (65535 & n2.M) + (65535 & r2.M) + (e2 >>> 16), e2 = (n2.M >>> 16) + (r2.M >>> 16) + (t2 >>> 16), new X((65535 & e2) << 16 | 65535 & t2, i2);
      }
      function Z(n2, r2, t2, e2) {
        var i2, o2;
        i2 = (65535 & n2.X) + (65535 & r2.X) + (65535 & t2.X) + (65535 & e2.X);
        var u2 = (65535 & (o2 = (n2.X >>> 16) + (r2.X >>> 16) + (t2.X >>> 16) + (e2.X >>> 16) + (i2 >>> 16))) << 16 | 65535 & i2;
        return i2 = (65535 & n2.M) + (65535 & r2.M) + (65535 & t2.M) + (65535 & e2.M) + (o2 >>> 16), o2 = (n2.M >>> 16) + (r2.M >>> 16) + (t2.M >>> 16) + (e2.M >>> 16) + (i2 >>> 16), new X((65535 & o2) << 16 | 65535 & i2, u2);
      }
      function q(n2, r2, t2, e2, i2) {
        var o2, u2;
        o2 = (65535 & n2.X) + (65535 & r2.X) + (65535 & t2.X) + (65535 & e2.X) + (65535 & i2.X);
        var f2 = (65535 & (u2 = (n2.X >>> 16) + (r2.X >>> 16) + (t2.X >>> 16) + (e2.X >>> 16) + (i2.X >>> 16) + (o2 >>> 16))) << 16 | 65535 & o2;
        return o2 = (65535 & n2.M) + (65535 & r2.M) + (65535 & t2.M) + (65535 & e2.M) + (65535 & i2.M) + (u2 >>> 16), u2 = (n2.M >>> 16) + (r2.M >>> 16) + (t2.M >>> 16) + (e2.M >>> 16) + (i2.M >>> 16) + (o2 >>> 16), new X((65535 & u2) << 16 | 65535 & o2, f2);
      }
      function D(n2, r2) {
        return new X(n2.M ^ r2.M, n2.X ^ r2.X);
      }
      function G(n2, r2, t2, e2, i2) {
        return new X(n2.M ^ r2.M ^ t2.M ^ e2.M ^ i2.M, n2.X ^ r2.X ^ t2.X ^ e2.X ^ i2.X);
      }
      function J(n2) {
        var r2 = O(n2, 19), t2 = O(n2, 61), e2 = j(n2, 6);
        return new X(r2.M ^ t2.M ^ e2.M, r2.X ^ t2.X ^ e2.X);
      }
      function Q(n2) {
        var r2 = O(n2, 1), t2 = O(n2, 8), e2 = j(n2, 7);
        return new X(r2.M ^ t2.M ^ e2.M, r2.X ^ t2.X ^ e2.X);
      }
      function W(n2) {
        var r2 = O(n2, 14), t2 = O(n2, 18), e2 = O(n2, 41);
        return new X(r2.M ^ t2.M ^ e2.M, r2.X ^ t2.X ^ e2.X);
      }
      var $ = [new X(f[0], 3609767458), new X(f[1], 602891725), new X(f[2], 3964484399), new X(f[3], 2173295548), new X(f[4], 4081628472), new X(f[5], 3053834265), new X(f[6], 2937671579), new X(f[7], 3664609560), new X(f[8], 2734883394), new X(f[9], 1164996542), new X(f[10], 1323610764), new X(f[11], 3590304994), new X(f[12], 4068182383), new X(f[13], 991336113), new X(f[14], 633803317), new X(f[15], 3479774868), new X(f[16], 2666613458), new X(f[17], 944711139), new X(f[18], 2341262773), new X(f[19], 2007800933), new X(f[20], 1495990901), new X(f[21], 1856431235), new X(f[22], 3175218132), new X(f[23], 2198950837), new X(f[24], 3999719339), new X(f[25], 766784016), new X(f[26], 2566594879), new X(f[27], 3203337956), new X(f[28], 1034457026), new X(f[29], 2466948901), new X(f[30], 3758326383), new X(f[31], 168717936), new X(f[32], 1188179964), new X(f[33], 1546045734), new X(f[34], 1522805485), new X(f[35], 2643833823), new X(f[36], 2343527390), new X(f[37], 1014477480), new X(f[38], 1206759142), new X(f[39], 344077627), new X(f[40], 1290863460), new X(f[41], 3158454273), new X(f[42], 3505952657), new X(f[43], 106217008), new X(f[44], 3606008344), new X(f[45], 1432725776), new X(f[46], 1467031594), new X(f[47], 851169720), new X(f[48], 3100823752), new X(f[49], 1363258195), new X(f[50], 3750685593), new X(f[51], 3785050280), new X(f[52], 3318307427), new X(f[53], 3812723403), new X(f[54], 2003034995), new X(f[55], 3602036899), new X(f[56], 1575990012), new X(f[57], 1125592928), new X(f[58], 2716904306), new X(f[59], 442776044), new X(f[60], 593698344), new X(f[61], 3733110249), new X(f[62], 2999351573), new X(f[63], 3815920427), new X(3391569614, 3928383900), new X(3515267271, 566280711), new X(3940187606, 3454069534), new X(4118630271, 4000239992), new X(116418474, 1914138554), new X(174292421, 2731055270), new X(289380356, 3203993006), new X(460393269, 320620315), new X(685471733, 587496836), new X(852142971, 1086792851), new X(1017036298, 365543100), new X(1126000580, 2618297676), new X(1288033470, 3409855158), new X(1501505948, 4234509866), new X(1607167915, 987167468), new X(1816402316, 1246189591)];
      function nn(n2) {
        return "SHA-384" === n2 ? [new X(3418070365, s[0]), new X(1654270250, s[1]), new X(2438529370, s[2]), new X(355462360, s[3]), new X(1731405415, s[4]), new X(41048885895, s[5]), new X(3675008525, s[6]), new X(1203062813, s[7])] : [new X(w[0], 4089235720), new X(w[1], 2227873595), new X(w[2], 4271175723), new X(w[3], 1595750129), new X(w[4], 2917565137), new X(w[5], 725511199), new X(w[6], 4215389547), new X(w[7], 327033209)];
      }
      function rn(n2, r2) {
        var t2, e2, i2, o2, u2, f2, s2, w2, a2, h2, c2, v2, A2 = [];
        for (t2 = r2[0], e2 = r2[1], i2 = r2[2], o2 = r2[3], u2 = r2[4], f2 = r2[5], s2 = r2[6], w2 = r2[7], c2 = 0; c2 < 80; c2 += 1) c2 < 16 ? (v2 = 2 * c2, A2[c2] = new X(n2[v2], n2[v2 + 1])) : A2[c2] = Z(J(A2[c2 - 2]), A2[c2 - 7], Q(A2[c2 - 15]), A2[c2 - 16]), a2 = q(w2, W(u2), _(u2, f2, s2), $[c2], A2[c2]), h2 = V(P(t2), x(t2, e2, i2)), w2 = s2, s2 = f2, f2 = u2, u2 = V(o2, a2), o2 = i2, i2 = e2, e2 = t2, t2 = V(a2, h2);
        return r2[0] = V(t2, r2[0]), r2[1] = V(e2, r2[1]), r2[2] = V(i2, r2[2]), r2[3] = V(o2, r2[3]), r2[4] = V(u2, r2[4]), r2[5] = V(f2, r2[5]), r2[6] = V(s2, r2[6]), r2[7] = V(w2, r2[7]), r2;
      }
      var tn = (function(n2) {
        function r2(r3, t2, e2) {
          var o2 = this;
          if ("SHA-384" !== r3 && "SHA-512" !== r3) throw new Error(a);
          var f2 = e2 || {};
          return (o2 = n2.call(this, r3, t2, e2) || this).K = o2.I, o2.Y = true, o2.F = -1, o2.m = i(o2.t, o2.i, o2.F), o2.R = rn, o2.B = function(n3) {
            return n3.slice();
          }, o2.k = nn, o2.L = function(n3, t3, e3, i2) {
            return (function(n4, r4, t4, e4, i3) {
              for (var o3, f3 = 31 + (r4 + 129 >>> 10 << 5), s2 = r4 + t4; n4.length <= f3; ) n4.push(0);
              for (n4[r4 >>> 5] |= 128 << 24 - r4 % 32, n4[f3] = 4294967295 & s2, n4[f3 - 1] = s2 / u | 0, o3 = 0; o3 < n4.length; o3 += 32) e4 = rn(n4.slice(o3, o3 + 32), e4);
              return "SHA-384" === i3 ? [e4[0].M, e4[0].X, e4[1].M, e4[1].X, e4[2].M, e4[2].X, e4[3].M, e4[3].X, e4[4].M, e4[4].X, e4[5].M, e4[5].X] : [e4[0].M, e4[0].X, e4[1].M, e4[1].X, e4[2].M, e4[2].X, e4[3].M, e4[3].X, e4[4].M, e4[4].X, e4[5].M, e4[5].X, e4[6].M, e4[6].X, e4[7].M, e4[7].X];
            })(n3, t3, e3, i2, r3);
          }, o2.U = nn(r3), o2.p = 1024, o2.T = "SHA-384" === r3 ? 384 : 512, o2.C = false, f2.hmacKey && o2.N(A("hmacKey", f2.hmacKey, o2.F)), o2;
        }
        return b(r2, n2), r2;
      })(E), en = [new X(0, 1), new X(0, 32898), new X(2147483648, 32906), new X(2147483648, 2147516416), new X(0, 32907), new X(0, 2147483649), new X(2147483648, 2147516545), new X(2147483648, 32777), new X(0, 138), new X(0, 136), new X(0, 2147516425), new X(0, 2147483658), new X(0, 2147516555), new X(2147483648, 139), new X(2147483648, 32905), new X(2147483648, 32771), new X(2147483648, 32770), new X(2147483648, 128), new X(0, 32778), new X(2147483648, 2147483658), new X(2147483648, 2147516545), new X(2147483648, 32896), new X(0, 2147483649), new X(2147483648, 2147516424)], on = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]];
      function un(n2) {
        var r2, t2 = [];
        for (r2 = 0; r2 < 5; r2 += 1) t2[r2] = [new X(0, 0), new X(0, 0), new X(0, 0), new X(0, 0), new X(0, 0)];
        return t2;
      }
      function fn(n2) {
        var r2, t2 = [];
        for (r2 = 0; r2 < 5; r2 += 1) t2[r2] = n2[r2].slice();
        return t2;
      }
      function sn(n2, r2) {
        var t2, e2, i2, o2, u2 = [], f2 = [];
        if (null !== n2) for (e2 = 0; e2 < n2.length; e2 += 2) r2[(e2 >>> 1) % 5][(e2 >>> 1) / 5 | 0] = D(r2[(e2 >>> 1) % 5][(e2 >>> 1) / 5 | 0], new X(n2[e2 + 1], n2[e2]));
        for (t2 = 0; t2 < 24; t2 += 1) {
          for (o2 = un(), e2 = 0; e2 < 5; e2 += 1) u2[e2] = G(r2[e2][0], r2[e2][1], r2[e2][2], r2[e2][3], r2[e2][4]);
          for (e2 = 0; e2 < 5; e2 += 1) f2[e2] = D(u2[(e2 + 4) % 5], z(u2[(e2 + 1) % 5], 1));
          for (e2 = 0; e2 < 5; e2 += 1) for (i2 = 0; i2 < 5; i2 += 1) r2[e2][i2] = D(r2[e2][i2], f2[e2]);
          for (e2 = 0; e2 < 5; e2 += 1) for (i2 = 0; i2 < 5; i2 += 1) o2[i2][(2 * e2 + 3 * i2) % 5] = z(r2[e2][i2], on[e2][i2]);
          for (e2 = 0; e2 < 5; e2 += 1) for (i2 = 0; i2 < 5; i2 += 1) r2[e2][i2] = D(o2[e2][i2], new X(~o2[(e2 + 1) % 5][i2].M & o2[(e2 + 2) % 5][i2].M, ~o2[(e2 + 1) % 5][i2].X & o2[(e2 + 2) % 5][i2].X));
          r2[0][0] = D(r2[0][0], en[t2]);
        }
        return r2;
      }
      function wn(n2) {
        var r2, t2, e2 = 0, i2 = [0, 0], o2 = [4294967295 & n2, n2 / u & 2097151];
        for (r2 = 6; r2 >= 0; r2--) 0 === (t2 = o2[r2 >> 2] >>> 8 * r2 & 255) && 0 === e2 || (i2[e2 + 1 >> 2] |= t2 << 8 * (e2 + 1), e2 += 1);
        return e2 = 0 !== e2 ? e2 : 1, i2[0] |= e2, { value: e2 + 1 > 4 ? i2 : [i2[0]], binLen: 8 + 8 * e2 };
      }
      function an(n2) {
        return c(wn(n2.binLen), n2);
      }
      function hn(n2, r2) {
        var t2, e2 = wn(r2), i2 = r2 >>> 2, o2 = (i2 - (e2 = c(e2, n2)).value.length % i2) % i2;
        for (t2 = 0; t2 < o2; t2++) e2.value.push(0);
        return e2.value;
      }
      var cn = (function(n2) {
        function r2(r3, t2, e2) {
          var o2 = this, u2 = 6, f2 = 0, s2 = e2 || {};
          if (1 !== (o2 = n2.call(this, r3, t2, e2) || this).numRounds) {
            if (s2.kmacKey || s2.hmacKey) throw new Error(h);
            if ("CSHAKE128" === o2.o || "CSHAKE256" === o2.o) throw new Error("Cannot set numRounds for CSHAKE variants");
          }
          switch (o2.F = 1, o2.m = i(o2.t, o2.i, o2.F), o2.R = sn, o2.B = fn, o2.k = un, o2.U = un(), o2.C = false, r3) {
            case "SHA3-224":
              o2.p = f2 = 1152, o2.T = 224, o2.Y = true, o2.K = o2.I;
              break;
            case "SHA3-256":
              o2.p = f2 = 1088, o2.T = 256, o2.Y = true, o2.K = o2.I;
              break;
            case "SHA3-384":
              o2.p = f2 = 832, o2.T = 384, o2.Y = true, o2.K = o2.I;
              break;
            case "SHA3-512":
              o2.p = f2 = 576, o2.T = 512, o2.Y = true, o2.K = o2.I;
              break;
            case "SHAKE128":
              u2 = 31, o2.p = f2 = 1344, o2.T = -1, o2.C = true, o2.Y = false, o2.K = null;
              break;
            case "SHAKE256":
              u2 = 31, o2.p = f2 = 1088, o2.T = -1, o2.C = true, o2.Y = false, o2.K = null;
              break;
            case "KMAC128":
              u2 = 4, o2.p = f2 = 1344, o2.O(e2), o2.T = -1, o2.C = true, o2.Y = false, o2.K = o2.j;
              break;
            case "KMAC256":
              u2 = 4, o2.p = f2 = 1088, o2.O(e2), o2.T = -1, o2.C = true, o2.Y = false, o2.K = o2.j;
              break;
            case "CSHAKE128":
              o2.p = f2 = 1344, u2 = o2._(e2), o2.T = -1, o2.C = true, o2.Y = false, o2.K = null;
              break;
            case "CSHAKE256":
              o2.p = f2 = 1088, u2 = o2._(e2), o2.T = -1, o2.C = true, o2.Y = false, o2.K = null;
              break;
            default:
              throw new Error(a);
          }
          return o2.L = function(n3, r4, t3, e3, i2) {
            return (function(n4, r5, t4, e4, i3, o3, u3) {
              var f3, s3, w2 = 0, a2 = [], h2 = i3 >>> 5, c2 = r5 >>> 5;
              for (f3 = 0; f3 < c2 && r5 >= i3; f3 += h2) e4 = sn(n4.slice(f3, f3 + h2), e4), r5 -= i3;
              for (n4 = n4.slice(f3), r5 %= i3; n4.length < h2; ) n4.push(0);
              for (n4[(f3 = r5 >>> 3) >> 2] ^= o3 << f3 % 4 * 8, n4[h2 - 1] ^= 2147483648, e4 = sn(n4, e4); 32 * a2.length < u3 && (s3 = e4[w2 % 5][w2 / 5 | 0], a2.push(s3.X), !(32 * a2.length >= u3)); ) a2.push(s3.M), 0 == 64 * (w2 += 1) % i3 && (sn(null, e4), w2 = 0);
              return a2;
            })(n3, r4, 0, e3, f2, u2, i2);
          }, s2.hmacKey && o2.N(A("hmacKey", s2.hmacKey, o2.F)), o2;
        }
        return b(r2, n2), r2.prototype._ = function(n3, r3) {
          var t2 = (function(n4) {
            var r4 = n4 || {};
            return { funcName: A("funcName", r4.funcName, 1, { value: [], binLen: 0 }), customization: A("Customization", r4.customization, 1, { value: [], binLen: 0 }) };
          })(n3 || {});
          r3 && (t2.funcName = r3);
          var e2 = c(an(t2.funcName), an(t2.customization));
          if (0 !== t2.customization.binLen || 0 !== t2.funcName.binLen) {
            for (var i2 = hn(e2, this.p >>> 3), o2 = 0; o2 < i2.length; o2 += this.p >>> 5) this.U = this.R(i2.slice(o2, o2 + (this.p >>> 5)), this.U), this.A += this.p;
            return 4;
          }
          return 31;
        }, r2.prototype.O = function(n3) {
          var r3 = (function(n4) {
            var r4 = n4 || {};
            return { kmacKey: A("kmacKey", r4.kmacKey, 1), funcName: { value: [1128353099], binLen: 32 }, customization: A("Customization", r4.customization, 1, { value: [], binLen: 0 }) };
          })(n3 || {});
          this._(n3, r3.funcName);
          for (var t2 = hn(an(r3.kmacKey), this.p >>> 3), e2 = 0; e2 < t2.length; e2 += this.p >>> 5) this.U = this.R(t2.slice(e2, e2 + (this.p >>> 5)), this.U), this.A += this.p;
          this.l = true;
        }, r2.prototype.j = function(n3) {
          var r3 = c({ value: this.u.slice(), binLen: this.h }, (function(n4) {
            var r4, t2, e2 = 0, i2 = [0, 0], o2 = [4294967295 & n4, n4 / u & 2097151];
            for (r4 = 6; r4 >= 0; r4--) 0 == (t2 = o2[r4 >> 2] >>> 8 * r4 & 255) && 0 === e2 || (i2[e2 >> 2] |= t2 << 8 * e2, e2 += 1);
            return i2[(e2 = 0 !== e2 ? e2 : 1) >> 2] |= e2 << 8 * e2, { value: e2 + 1 > 4 ? i2 : [i2[0]], binLen: 8 + 8 * e2 };
          })(n3.outputLen));
          return this.L(r3.value, r3.binLen, this.A, this.B(this.U), n3.outputLen);
        }, r2;
      })(E);
      return (function() {
        function n2(n3, r2, t2) {
          if ("SHA-1" == n3) this.P = new Y(n3, r2, t2);
          else if ("SHA-224" == n3 || "SHA-256" == n3) this.P = new M(n3, r2, t2);
          else if ("SHA-384" == n3 || "SHA-512" == n3) this.P = new tn(n3, r2, t2);
          else {
            if ("SHA3-224" != n3 && "SHA3-256" != n3 && "SHA3-384" != n3 && "SHA3-512" != n3 && "SHAKE128" != n3 && "SHAKE256" != n3 && "CSHAKE128" != n3 && "CSHAKE256" != n3 && "KMAC128" != n3 && "KMAC256" != n3) throw new Error(a);
            this.P = new cn(n3, r2, t2);
          }
        }
        return n2.prototype.update = function(n3) {
          return this.P.update(n3), this;
        }, n2.prototype.getHash = function(n3, r2) {
          return this.P.getHash(n3, r2);
        }, n2.prototype.setHMACKey = function(n3, r2, t2) {
          this.P.setHMACKey(n3, r2, t2);
        }, n2.prototype.getHMAC = function(n3, r2) {
          return this.P.getHMAC(n3, r2);
        }, n2;
      })();
    });
  }
});

// ../node_modules/.pnpm/chia-bls@1.0.3/node_modules/chia-bls/dist/src/index.js
var require_src = __commonJS({
  "../node_modules/.pnpm/chia-bls@1.0.3/node_modules/chia-bls/dist/src/index.js"(exports, module) {
    var $fpZC2$jssha = require_sha();
    function $parcel$exportWildcard(dest, source) {
      Object.keys(source).forEach(function(key) {
        if (key === "default" || key === "__esModule" || Object.prototype.hasOwnProperty.call(dest, key)) {
          return;
        }
        Object.defineProperty(dest, key, {
          enumerable: true,
          get: function get() {
            return source[key];
          }
        });
      });
      return dest;
    }
    function $parcel$export(e, n, v, s) {
      Object.defineProperty(e, n, { get: v, set: s, enumerable: true, configurable: true });
    }
    function $parcel$interopDefault(a) {
      return a && a.__esModule ? a.default : a;
    }
    var $dedcfd393dea00ca$exports = {};
    var $6c617017d170275f$exports = {};
    $parcel$export($6c617017d170275f$exports, "Field", () => $6c617017d170275f$export$a455218a85c89869);
    var $6c617017d170275f$export$a455218a85c89869 = class {
    };
    var $dde8a229c2cb8a5c$exports = {};
    $parcel$export($dde8a229c2cb8a5c$exports, "FieldExt", () => $dde8a229c2cb8a5c$export$d11d456c2f7a68f6);
    var $dde8a229c2cb8a5c$export$d11d456c2f7a68f6 = class _$dde8a229c2cb8a5c$export$d11d456c2f7a68f6 extends (0, $6c617017d170275f$export$a455218a85c89869) {
      Q;
      elements;
      basefield;
      constructor(Q, elements) {
        super();
        this.Q = Q;
        this.elements = elements;
        this.basefield = elements[0];
      }
      constructWithRoot(Q, elements) {
        return this.construct(Q, elements).withRoot(this.root);
      }
      withRoot(root) {
        this.root = root;
        return this;
      }
      fromBytes(Q, bytes) {
        const length = this.extension * 48;
        if (bytes.length !== length) throw new RangeError(`Expected ${length} bytes.`);
        const embeddedSize = 48 * (this.extension / this.elements.length);
        const elements = [];
        for (let i = 0; i < this.elements.length; i++) elements.push(bytes.slice(i * embeddedSize, (i + 1) * embeddedSize));
        return new this.constructor(Q, ...elements.reverse().map((bytes2) => this.basefield.fromBytes(Q, bytes2)));
      }
      fromHex(Q, hex) {
        return this.fromBytes(Q, (0, $11b8831ba7e63616$export$1a8ceedbd5845648)(hex));
      }
      fromFq(Q, fq) {
        const y = this.basefield.fromFq(Q, fq);
        const z = this.basefield.zero(Q);
        const elements = [];
        for (let i = 0; i < this.elements.length; i++) elements.push(i === 0 ? y : z);
        const result = this.construct(Q, elements);
        if (this instanceof (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)) result.root = new (0, $61122e18a0bc5a58$export$312db8bf004879ae)(Q, -1n);
        else if (this instanceof (0, $f9eca204c73b879f$export$4b83d0846fa6fe37)) result.root = new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)(Q, (0, $61122e18a0bc5a58$export$312db8bf004879ae).nil.one(Q), (0, $61122e18a0bc5a58$export$312db8bf004879ae).nil.one(Q));
        else if (this instanceof (0, $e01fe8766586be5e$export$d12e5c25403eca16)) result.root = new (0, $f9eca204c73b879f$export$4b83d0846fa6fe37)(Q, (0, $ee4c81c840b9d78d$export$3250f1bd1b840331).nil.zero(Q), (0, $ee4c81c840b9d78d$export$3250f1bd1b840331).nil.one(Q), (0, $ee4c81c840b9d78d$export$3250f1bd1b840331).nil.zero(Q));
        return result;
      }
      zero(Q) {
        return this.fromFq(Q, new (0, $61122e18a0bc5a58$export$312db8bf004879ae)(Q, 0n));
      }
      one(Q) {
        return this.fromFq(Q, new (0, $61122e18a0bc5a58$export$312db8bf004879ae)(Q, 1n));
      }
      clone() {
        return this.constructWithRoot(this.Q, this.elements.map((element) => element.clone()));
      }
      toBytes() {
        const bytes = [];
        for (let i = this.elements.length - 1; i >= 0; i--) bytes.push(...this.elements[i].toBytes());
        return Uint8Array.from(bytes);
      }
      toBool() {
        return this.elements.findIndex((element) => !element.toBool()) === -1;
      }
      toHex() {
        return (0, $11b8831ba7e63616$export$7ea66e3774a60b67)(this.toBytes());
      }
      toString() {
        return `Fq${this.extension}(${this.elements.join(", ")})`;
      }
      negate() {
        return this.constructWithRoot(this.Q, this.elements.map((element) => element.negate()));
      }
      qiPower(i) {
        if (this.Q != (0, $00e9cfcde39d0b4a$export$9e5f44173e64f162)) throw new (0, $652b9d23a743e8c2$export$b279dc3e096c808b)("Invalid Q in qiPower.");
        i = (0, $013cd1e91a5ae572$export$64b58c5b0372ae95)(i, this.extension);
        if (i === 0) return this;
        return this.constructWithRoot(this.Q, this.elements.map((element, index) => index === 0 ? element.qiPower(i) : element.qiPower(i).multiply((0, $3dc2627f1a74b978$export$3fa013b223651431)(this.extension, i, index))));
      }
      pow(exponent) {
        (0, $8d5e30fd5fa02b49$export$a7a9523472993e97)(exponent >= 0n);
        let result = this.one(this.Q).withRoot(this.root);
        let base = this;
        while (exponent != 0n) {
          if (exponent & 1n) result = result.multiply(base);
          base = base.multiply(base);
          exponent >>= 1n;
        }
        return result;
      }
      addTo(value) {
        let elements;
        if (value instanceof _$dde8a229c2cb8a5c$export$d11d456c2f7a68f6 && value instanceof this.constructor) elements = value.elements;
        else {
          if (typeof value !== "bigint" && value.extension > this.extension) throw new (0, $652b9d23a743e8c2$export$b279dc3e096c808b)("Operand must be higher than extension.");
          elements = this.elements.map(() => this.basefield.zero(this.Q));
          elements[0] = elements[0].add(value);
        }
        return this.constructWithRoot(this.Q, this.elements.map((element, i) => element.add(elements[i])));
      }
      multiplyWith(value) {
        if (typeof value === "bigint") return this.constructWithRoot(this.Q, this.elements.map((element) => element.multiply(value)));
        else if (this.extension < value.extension) throw new (0, $652b9d23a743e8c2$export$b279dc3e096c808b)("Extension must be lower than operand.");
        const elements = this.elements.map(() => this.basefield.zero(this.Q));
        for (const [i, x] of this.elements.entries()) {
          if (value instanceof _$dde8a229c2cb8a5c$export$d11d456c2f7a68f6 && value.extension === this.extension) {
            for (const [j, y] of value.elements.entries()) if (x.toBool() && y.toBool()) {
              const index = (0, $013cd1e91a5ae572$export$64b58c5b0372ae95)(i + j, this.elements.length);
              if (i + j >= this.elements.length) elements[index] = elements[index].add(x.multiply(y).multiply(this.root));
              else elements[index] = elements[index].add(x.multiply(y));
            }
          } else if (x.toBool()) elements[i] = x.multiply(value);
        }
        return this.constructWithRoot(this.Q, elements);
      }
      subtract(value) {
        return this.add(typeof value === "bigint" ? -value : value.negate());
      }
      divide(value) {
        return this.multiply(typeof value === "bigint" ? ~value : value.inverse());
      }
      equalTo(value) {
        if (!(value instanceof _$dde8a229c2cb8a5c$export$d11d456c2f7a68f6 && value instanceof this.constructor)) {
          if (typeof value === "bigint" || value instanceof _$dde8a229c2cb8a5c$export$d11d456c2f7a68f6 && this.extension > value.extension) {
            for (let i = 1; i < this.elements.length; i++) {
              if (!this.elements[i].equals(this.root.zero(this.Q))) return false;
            }
            return this.elements[0].equals(value);
          }
          throw new (0, $652b9d23a743e8c2$export$b279dc3e096c808b)("Invalid operand.");
        } else return this.elements.findIndex((element, i) => !element.equals(value.elements[i])) === -1 && this.Q === value.Q;
      }
      lt(value) {
        for (let i = this.elements.length - 1; i >= 0; i--) {
          const a = this.elements[i];
          const b = value.elements[i];
          if (a.lt(b)) return true;
          else if (a.gt(b)) return false;
        }
        return false;
      }
      gt(value) {
        for (let i = this.elements.length - 1; i >= 0; i--) {
          const a = this.elements[i];
          const b = value.elements[i];
          if (a.gt(b)) return true;
          else if (a.lt(b)) return false;
        }
        return false;
      }
      lteq(value) {
        return this.lt(value) || this.equals(value);
      }
      gteq(value) {
        return this.gt(value) || this.equals(value);
      }
      add(value) {
        try {
          return this.addTo(value);
        } catch (error) {
          if (!(error instanceof (0, $652b9d23a743e8c2$export$b279dc3e096c808b)) || typeof value === "bigint") throw error;
          return value.addTo(this);
        }
      }
      multiply(value) {
        try {
          return this.multiplyWith(value);
        } catch (error) {
          if (!(error instanceof (0, $652b9d23a743e8c2$export$b279dc3e096c808b)) || typeof value === "bigint") throw error;
          return value.multiplyWith(this);
        }
      }
      equals(value) {
        try {
          return this.equalTo(value);
        } catch (error) {
          if (!(error instanceof (0, $652b9d23a743e8c2$export$b279dc3e096c808b))) throw error;
          return typeof value === "bigint" ? false : value.equalTo(this);
        }
      }
    };
    var $61122e18a0bc5a58$exports = {};
    $parcel$export($61122e18a0bc5a58$exports, "Fq", () => $61122e18a0bc5a58$export$312db8bf004879ae);
    var $61122e18a0bc5a58$export$312db8bf004879ae = class _$61122e18a0bc5a58$export$312db8bf004879ae extends (0, $6c617017d170275f$export$a455218a85c89869) {
      Q;
      static nil = new _$61122e18a0bc5a58$export$312db8bf004879ae(1n, 0n);
      extension;
      value;
      constructor(Q, value) {
        super();
        this.Q = Q;
        this.extension = 1;
        this.value = (0, $013cd1e91a5ae572$export$842a2cf37af977e1)(value, Q);
      }
      fromBytes(Q, bytes) {
        if (bytes.length !== 48) throw new RangeError("Expected 48 bytes.");
        return new _$61122e18a0bc5a58$export$312db8bf004879ae(Q, (0, $11b8831ba7e63616$export$2a52511e4f35930a)(bytes, "big"));
      }
      fromHex(Q, hex) {
        return _$61122e18a0bc5a58$export$312db8bf004879ae.nil.fromBytes(Q, (0, $11b8831ba7e63616$export$1a8ceedbd5845648)(hex));
      }
      fromFq(_Q, fq) {
        return fq;
      }
      zero(Q) {
        return new _$61122e18a0bc5a58$export$312db8bf004879ae(Q, 0n);
      }
      one(Q) {
        return new _$61122e18a0bc5a58$export$312db8bf004879ae(Q, 1n);
      }
      clone() {
        return new _$61122e18a0bc5a58$export$312db8bf004879ae(this.Q, this.value);
      }
      toBytes() {
        return (0, $11b8831ba7e63616$export$c0f6630717bc20c7)(this.value, 48, "big");
      }
      toBool() {
        return true;
      }
      toHex() {
        return (0, $11b8831ba7e63616$export$7ea66e3774a60b67)(this.toBytes());
      }
      toString() {
        const hex = this.value.toString(16);
        return `Fq(0x${hex.length > 10 ? `${hex.slice(0, 5)}..${hex.slice(hex.length - 5)}` : hex})`;
      }
      negate() {
        return new _$61122e18a0bc5a58$export$312db8bf004879ae(this.Q, -this.value);
      }
      inverse() {
        let x0 = 1n, x1 = 0n, y0 = 0n, y1 = 1n;
        let a = this.Q;
        let b = this.value;
        while (a != 0n) {
          const q = b / a;
          const tempB = b;
          b = a;
          a = (0, $013cd1e91a5ae572$export$842a2cf37af977e1)(tempB, a);
          const temp_x0 = x0;
          x0 = x1;
          x1 = temp_x0 - q * x1;
          const temp_y0 = y0;
          y0 = y1;
          y1 = temp_y0 - q * y1;
        }
        return new _$61122e18a0bc5a58$export$312db8bf004879ae(this.Q, x0);
      }
      qiPower(_i) {
        return this;
      }
      pow(exponent) {
        return exponent === 0n ? new _$61122e18a0bc5a58$export$312db8bf004879ae(this.Q, 1n) : exponent === 1n ? new _$61122e18a0bc5a58$export$312db8bf004879ae(this.Q, this.value) : (0, $013cd1e91a5ae572$export$842a2cf37af977e1)(exponent, 2n) === 0n ? new _$61122e18a0bc5a58$export$312db8bf004879ae(this.Q, this.value * this.value).pow(exponent / 2n) : new _$61122e18a0bc5a58$export$312db8bf004879ae(this.Q, this.value * this.value).pow(exponent / 2n).multiply(this);
      }
      addTo(value) {
        if (typeof value === "bigint") return new _$61122e18a0bc5a58$export$312db8bf004879ae(this.Q, this.value + value);
        else if (value instanceof _$61122e18a0bc5a58$export$312db8bf004879ae) return new _$61122e18a0bc5a58$export$312db8bf004879ae(this.Q, this.value + value.value);
        else throw new (0, $652b9d23a743e8c2$export$b279dc3e096c808b)("Can only add with Fq or bigint values.");
      }
      multiplyWith(value) {
        if (typeof value === "bigint") return new _$61122e18a0bc5a58$export$312db8bf004879ae(this.Q, this.value * value);
        else if (value instanceof _$61122e18a0bc5a58$export$312db8bf004879ae) return new _$61122e18a0bc5a58$export$312db8bf004879ae(this.Q, this.value * value.value);
        else throw new (0, $652b9d23a743e8c2$export$b279dc3e096c808b)("Can only multiply with Fq or bigint values.");
      }
      subtract(value) {
        return this.add(typeof value === "bigint" ? -value : value.negate());
      }
      divide(value) {
        return this.multiply((typeof value === "bigint" ? new _$61122e18a0bc5a58$export$312db8bf004879ae(this.Q, value) : value).inverse());
      }
      equalTo(value) {
        return value instanceof _$61122e18a0bc5a58$export$312db8bf004879ae && this.value === value.value && this.Q === value.Q;
      }
      lt(value) {
        return this.value < value.value;
      }
      gt(value) {
        return this.value > value.value;
      }
      lteq(value) {
        return this.lt(value) || this.equals(value);
      }
      gteq(value) {
        return this.gt(value) || this.equals(value);
      }
      modSqrt() {
        if (this.value === 0n) return new _$61122e18a0bc5a58$export$312db8bf004879ae(this.Q, 0n);
        else if ((0, $013cd1e91a5ae572$export$9747a4fa913461f)(this.value, (this.Q - 1n) / 2n, this.Q) != 1n) throw new Error("No sqrt exists.");
        else if ((0, $013cd1e91a5ae572$export$842a2cf37af977e1)(this.Q, 4n) === 3n) return new _$61122e18a0bc5a58$export$312db8bf004879ae(this.Q, (0, $013cd1e91a5ae572$export$9747a4fa913461f)(this.value, (this.Q + 1n) / 4n, this.Q));
        else if ((0, $013cd1e91a5ae572$export$842a2cf37af977e1)(this.Q, 8n) === 5n) return new _$61122e18a0bc5a58$export$312db8bf004879ae(this.Q, (0, $013cd1e91a5ae572$export$9747a4fa913461f)(this.value, (this.Q + 3n) / 8n, this.Q));
        let S = 0n;
        let q = this.Q - 1n;
        while ((0, $013cd1e91a5ae572$export$842a2cf37af977e1)(q, 2n) === 0n) {
          q /= 2n;
          S++;
        }
        let z = 0n;
        for (let i = 0n; i < this.Q; i += 1n) {
          const euler = (0, $013cd1e91a5ae572$export$9747a4fa913461f)(i, (this.Q - 1n) / 2n, this.Q);
          if (euler === (0, $013cd1e91a5ae572$export$842a2cf37af977e1)(-1n, this.Q)) {
            z = i;
            break;
          }
        }
        let M = S;
        let c = (0, $013cd1e91a5ae572$export$9747a4fa913461f)(z, q, this.Q);
        let t = (0, $013cd1e91a5ae572$export$9747a4fa913461f)(this.value, q, this.Q);
        let R = (0, $013cd1e91a5ae572$export$9747a4fa913461f)(this.value, (q + 1n) / 2n, this.Q);
        while (true) {
          if (t === 0n) return new _$61122e18a0bc5a58$export$312db8bf004879ae(this.Q, 0n);
          else if (t === 1n) return new _$61122e18a0bc5a58$export$312db8bf004879ae(this.Q, R);
          let i = 0n;
          let f = t;
          while (f != 1n) {
            f = (0, $013cd1e91a5ae572$export$842a2cf37af977e1)(f ** 2n, this.Q);
            i++;
          }
          const b = (0, $013cd1e91a5ae572$export$9747a4fa913461f)(c, (0, $013cd1e91a5ae572$export$9747a4fa913461f)(2n, M - i - 1n, this.Q), this.Q);
          M = i;
          c = (0, $013cd1e91a5ae572$export$842a2cf37af977e1)(b ** 2n, this.Q);
          t = (0, $013cd1e91a5ae572$export$842a2cf37af977e1)(t * c, this.Q);
          R = (0, $013cd1e91a5ae572$export$842a2cf37af977e1)(R * b, this.Q);
        }
      }
      add(value) {
        try {
          return this.addTo(value);
        } catch (error) {
          if (!(error instanceof (0, $652b9d23a743e8c2$export$b279dc3e096c808b)) || typeof value === "bigint") throw error;
          return value.addTo(this);
        }
      }
      multiply(value) {
        try {
          return this.multiplyWith(value);
        } catch (error) {
          if (!(error instanceof (0, $652b9d23a743e8c2$export$b279dc3e096c808b)) || typeof value === "bigint") throw error;
          return value.multiplyWith(this);
        }
      }
      equals(value) {
        try {
          return this.equalTo(value);
        } catch (error) {
          if (!(error instanceof (0, $652b9d23a743e8c2$export$b279dc3e096c808b))) throw error;
          return typeof value === "bigint" ? false : value.equalTo(this);
        }
      }
    };
    var $ee4c81c840b9d78d$exports = {};
    $parcel$export($ee4c81c840b9d78d$exports, "Fq2", () => $ee4c81c840b9d78d$export$3250f1bd1b840331);
    var $ee4c81c840b9d78d$export$3250f1bd1b840331 = class _$ee4c81c840b9d78d$export$3250f1bd1b840331 extends (0, $dde8a229c2cb8a5c$export$d11d456c2f7a68f6) {
      static nil = new _$ee4c81c840b9d78d$export$3250f1bd1b840331(1n, (0, $61122e18a0bc5a58$export$312db8bf004879ae).nil, (0, $61122e18a0bc5a58$export$312db8bf004879ae).nil);
      extension = 2;
      root;
      constructor(Q, x, y) {
        super(Q, [
          x,
          y
        ]);
        this.root = new (0, $61122e18a0bc5a58$export$312db8bf004879ae)(Q, -1n);
      }
      construct(Q, elements) {
        return new _$ee4c81c840b9d78d$export$3250f1bd1b840331(Q, elements[0], elements[1]);
      }
      inverse() {
        const [a, b] = this.elements;
        const factor = a.multiply(a).add(b.multiply(b)).inverse();
        return new _$ee4c81c840b9d78d$export$3250f1bd1b840331(this.Q, a.multiply(factor), b.negate().multiply(factor));
      }
      mulByNonResidue() {
        const [a, b] = this.elements;
        return new _$ee4c81c840b9d78d$export$3250f1bd1b840331(this.Q, a.subtract(b), a.add(b));
      }
      modSqrt() {
        const [a0, a1] = this.elements;
        if (a1.equals(this.basefield.one(this.Q))) return this.fromFq(this.Q, a0.modSqrt());
        let alpha = a0.pow(2n).add(a1.pow(2n));
        let gamma = alpha.pow((this.Q - 1n) / 2n);
        if (new (0, $61122e18a0bc5a58$export$312db8bf004879ae)(this.Q, -1n).equals(gamma)) throw new Error("No sqrt exists.");
        alpha = alpha.modSqrt();
        let delta = a0.add(alpha).multiply(new (0, $61122e18a0bc5a58$export$312db8bf004879ae)(this.Q, 2n).inverse());
        gamma = delta.pow((this.Q - 1n) / 2n);
        if (gamma.equals(new (0, $61122e18a0bc5a58$export$312db8bf004879ae)(this.Q, -1n))) delta = a0.subtract(alpha).multiply(new (0, $61122e18a0bc5a58$export$312db8bf004879ae)(this.Q, 2n).inverse());
        const x0 = delta.modSqrt();
        const x1 = a1.multiply(new (0, $61122e18a0bc5a58$export$312db8bf004879ae)(this.Q, 2n).multiply(x0).inverse());
        return new _$ee4c81c840b9d78d$export$3250f1bd1b840331(this.Q, x0, x1);
      }
    };
    var $f9eca204c73b879f$exports = {};
    $parcel$export($f9eca204c73b879f$exports, "Fq6", () => $f9eca204c73b879f$export$4b83d0846fa6fe37);
    var $f9eca204c73b879f$export$4b83d0846fa6fe37 = class _$f9eca204c73b879f$export$4b83d0846fa6fe37 extends (0, $dde8a229c2cb8a5c$export$d11d456c2f7a68f6) {
      static nil = new _$f9eca204c73b879f$export$4b83d0846fa6fe37(1n, (0, $ee4c81c840b9d78d$export$3250f1bd1b840331).nil, (0, $ee4c81c840b9d78d$export$3250f1bd1b840331).nil, (0, $ee4c81c840b9d78d$export$3250f1bd1b840331).nil);
      extension = 6;
      root;
      constructor(Q, x, y, z) {
        super(Q, [
          x,
          y,
          z
        ]);
        this.root = new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)(Q, (0, $61122e18a0bc5a58$export$312db8bf004879ae).nil.one(Q), (0, $61122e18a0bc5a58$export$312db8bf004879ae).nil.one(Q));
      }
      construct(Q, elements) {
        return new _$f9eca204c73b879f$export$4b83d0846fa6fe37(Q, elements[0], elements[1], elements[2]);
      }
      inverse() {
        const [a, b, c] = this.elements;
        const g0 = a.multiply(a).subtract(b.multiply(c.mulByNonResidue()));
        const g1 = c.multiply(c).mulByNonResidue().subtract(a.multiply(b));
        const g2 = b.multiply(b).subtract(a.multiply(c));
        const factor = g0.multiply(a).add(g1.multiply(c).add(g2.multiply(b)).mulByNonResidue()).inverse();
        return new _$f9eca204c73b879f$export$4b83d0846fa6fe37(this.Q, g0.multiply(factor), g1.multiply(factor), g2.multiply(factor));
      }
      mulByNonResidue() {
        const [a, b, c] = this.elements;
        return new _$f9eca204c73b879f$export$4b83d0846fa6fe37(this.Q, c.multiply(this.root), a, b);
      }
    };
    var $e01fe8766586be5e$exports = {};
    $parcel$export($e01fe8766586be5e$exports, "Fq12", () => $e01fe8766586be5e$export$d12e5c25403eca16);
    var $e01fe8766586be5e$export$d12e5c25403eca16 = class _$e01fe8766586be5e$export$d12e5c25403eca16 extends (0, $dde8a229c2cb8a5c$export$d11d456c2f7a68f6) {
      static nil = new _$e01fe8766586be5e$export$d12e5c25403eca16(1n, (0, $f9eca204c73b879f$export$4b83d0846fa6fe37).nil, (0, $f9eca204c73b879f$export$4b83d0846fa6fe37).nil);
      extension = 12;
      root;
      constructor(Q, x, y) {
        super(Q, [
          x,
          y
        ]);
        this.root = new (0, $f9eca204c73b879f$export$4b83d0846fa6fe37)(Q, (0, $ee4c81c840b9d78d$export$3250f1bd1b840331).nil.zero(Q), (0, $ee4c81c840b9d78d$export$3250f1bd1b840331).nil.one(Q), (0, $ee4c81c840b9d78d$export$3250f1bd1b840331).nil.zero(Q));
      }
      construct(Q, elements) {
        return new _$e01fe8766586be5e$export$d12e5c25403eca16(Q, elements[0], elements[1]);
      }
      inverse() {
        const [a, b] = this.elements;
        const factor = a.multiply(a).subtract(b.multiply(b).mulByNonResidue()).inverse();
        return new _$e01fe8766586be5e$export$d12e5c25403eca16(this.Q, a.multiply(factor), b.negate().multiply(factor));
      }
    };
    var $00e9cfcde39d0b4a$exports = {};
    $parcel$export($00e9cfcde39d0b4a$exports, "x", () => $00e9cfcde39d0b4a$export$d141bba7fdc215a3);
    $parcel$export($00e9cfcde39d0b4a$exports, "q", () => $00e9cfcde39d0b4a$export$9e5f44173e64f162);
    $parcel$export($00e9cfcde39d0b4a$exports, "a", () => $00e9cfcde39d0b4a$export$407448d2b89b1813);
    $parcel$export($00e9cfcde39d0b4a$exports, "b", () => $00e9cfcde39d0b4a$export$8b22cf2602fb60ce);
    $parcel$export($00e9cfcde39d0b4a$exports, "aTwist", () => $00e9cfcde39d0b4a$export$371e57e0e902051d);
    $parcel$export($00e9cfcde39d0b4a$exports, "bTwist", () => $00e9cfcde39d0b4a$export$a1902a2bd2e92b96);
    $parcel$export($00e9cfcde39d0b4a$exports, "gx", () => $00e9cfcde39d0b4a$export$881ce897a4237459);
    $parcel$export($00e9cfcde39d0b4a$exports, "gy", () => $00e9cfcde39d0b4a$export$5056eb87f1daa9b4);
    $parcel$export($00e9cfcde39d0b4a$exports, "g2x", () => $00e9cfcde39d0b4a$export$2cdfd364bfc1179f);
    $parcel$export($00e9cfcde39d0b4a$exports, "g2y", () => $00e9cfcde39d0b4a$export$85e678c171039b5a);
    $parcel$export($00e9cfcde39d0b4a$exports, "n", () => $00e9cfcde39d0b4a$export$7ccc53e8f1e7dfc5);
    $parcel$export($00e9cfcde39d0b4a$exports, "h", () => $00e9cfcde39d0b4a$export$dda1d9f60106f0e9);
    $parcel$export($00e9cfcde39d0b4a$exports, "hEff", () => $00e9cfcde39d0b4a$export$41b7b4fef7f76fa9);
    $parcel$export($00e9cfcde39d0b4a$exports, "k", () => $00e9cfcde39d0b4a$export$342063e11d6c3cad);
    $parcel$export($00e9cfcde39d0b4a$exports, "sqrtN3", () => $00e9cfcde39d0b4a$export$985f9eea851ca5f9);
    $parcel$export($00e9cfcde39d0b4a$exports, "sqrtN3m1o2", () => $00e9cfcde39d0b4a$export$3d2b20680da13ad6);
    $parcel$export($00e9cfcde39d0b4a$exports, "defaultEc", () => $00e9cfcde39d0b4a$export$df72980aaa0ca402);
    $parcel$export($00e9cfcde39d0b4a$exports, "defaultEcTwist", () => $00e9cfcde39d0b4a$export$89bff894721071da);
    var $00e9cfcde39d0b4a$export$d141bba7fdc215a3 = -0xd201000000010000n;
    var $00e9cfcde39d0b4a$export$9e5f44173e64f162 = 0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaabn;
    var $00e9cfcde39d0b4a$export$407448d2b89b1813 = new (0, $61122e18a0bc5a58$export$312db8bf004879ae)($00e9cfcde39d0b4a$export$9e5f44173e64f162, 0n);
    var $00e9cfcde39d0b4a$export$8b22cf2602fb60ce = new (0, $61122e18a0bc5a58$export$312db8bf004879ae)($00e9cfcde39d0b4a$export$9e5f44173e64f162, 4n);
    var $00e9cfcde39d0b4a$export$371e57e0e902051d = new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)($00e9cfcde39d0b4a$export$9e5f44173e64f162, new (0, $61122e18a0bc5a58$export$312db8bf004879ae)($00e9cfcde39d0b4a$export$9e5f44173e64f162, 0n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)($00e9cfcde39d0b4a$export$9e5f44173e64f162, 0n));
    var $00e9cfcde39d0b4a$export$a1902a2bd2e92b96 = new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)($00e9cfcde39d0b4a$export$9e5f44173e64f162, new (0, $61122e18a0bc5a58$export$312db8bf004879ae)($00e9cfcde39d0b4a$export$9e5f44173e64f162, 4n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)($00e9cfcde39d0b4a$export$9e5f44173e64f162, 4n));
    var $00e9cfcde39d0b4a$export$881ce897a4237459 = new (0, $61122e18a0bc5a58$export$312db8bf004879ae)($00e9cfcde39d0b4a$export$9e5f44173e64f162, 0x17f1d3a73197d7942695638c4fa9ac0fc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bbn);
    var $00e9cfcde39d0b4a$export$5056eb87f1daa9b4 = new (0, $61122e18a0bc5a58$export$312db8bf004879ae)($00e9cfcde39d0b4a$export$9e5f44173e64f162, 0x08b3f481e3aaa0f1a09e30ed741d8ae4fcf5e095d5d00af600db18cb2c04b3edd03cc744a2888ae40caa232946c5e7e1n);
    var $00e9cfcde39d0b4a$export$2cdfd364bfc1179f = new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)($00e9cfcde39d0b4a$export$9e5f44173e64f162, new (0, $61122e18a0bc5a58$export$312db8bf004879ae)($00e9cfcde39d0b4a$export$9e5f44173e64f162, 352701069587466618187139116011060144890029952792775240219908644239793785735715026873347600343865175952761926303160n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)($00e9cfcde39d0b4a$export$9e5f44173e64f162, 3059144344244213709971259814753781636986470325476647558659373206291635324768958432433509563104347017837885763365758n));
    var $00e9cfcde39d0b4a$export$85e678c171039b5a = new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)($00e9cfcde39d0b4a$export$9e5f44173e64f162, new (0, $61122e18a0bc5a58$export$312db8bf004879ae)($00e9cfcde39d0b4a$export$9e5f44173e64f162, 1985150602287291935568054521177171638300868978215655730859378665066344726373823718423869104263333984641494340347905n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)($00e9cfcde39d0b4a$export$9e5f44173e64f162, 927553665492332455747201965776037880757740193453592970025027978793976877002675564980949289727957565575433344219582n));
    var $00e9cfcde39d0b4a$export$7ccc53e8f1e7dfc5 = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001n;
    var $00e9cfcde39d0b4a$export$dda1d9f60106f0e9 = 0x396c8c005555e1568c00aaab0000aaabn;
    var $00e9cfcde39d0b4a$export$41b7b4fef7f76fa9 = 0xbc69f08f2ee75b3584c6a0ea91b352888e2a8e9145ad7689986ff031508ffe1329c2f178731db956d82bf015d1212b02ec0ec69d7477c1ae954cbc06689f6a359894c0adebbf6b4e8020005aaa95551n;
    var $00e9cfcde39d0b4a$export$342063e11d6c3cad = 12n;
    var $00e9cfcde39d0b4a$export$985f9eea851ca5f9 = 1586958781458431025242759403266842894121773480562120986020912974854563298150952611241517463240701n;
    var $00e9cfcde39d0b4a$export$3d2b20680da13ad6 = 793479390729215512621379701633421447060886740281060493010456487427281649075476305620758731620350n;
    var $00e9cfcde39d0b4a$export$df72980aaa0ca402 = {
      q: $00e9cfcde39d0b4a$export$9e5f44173e64f162,
      a: $00e9cfcde39d0b4a$export$407448d2b89b1813,
      b: $00e9cfcde39d0b4a$export$8b22cf2602fb60ce,
      gx: $00e9cfcde39d0b4a$export$881ce897a4237459,
      gy: $00e9cfcde39d0b4a$export$5056eb87f1daa9b4,
      g2x: $00e9cfcde39d0b4a$export$2cdfd364bfc1179f,
      g2y: $00e9cfcde39d0b4a$export$85e678c171039b5a,
      n: $00e9cfcde39d0b4a$export$7ccc53e8f1e7dfc5,
      h: $00e9cfcde39d0b4a$export$dda1d9f60106f0e9,
      x: $00e9cfcde39d0b4a$export$d141bba7fdc215a3,
      k: $00e9cfcde39d0b4a$export$342063e11d6c3cad,
      sqrtN3: $00e9cfcde39d0b4a$export$985f9eea851ca5f9,
      sqrtN3m1o2: $00e9cfcde39d0b4a$export$3d2b20680da13ad6
    };
    var $00e9cfcde39d0b4a$export$89bff894721071da = {
      q: $00e9cfcde39d0b4a$export$9e5f44173e64f162,
      a: $00e9cfcde39d0b4a$export$371e57e0e902051d,
      b: $00e9cfcde39d0b4a$export$a1902a2bd2e92b96,
      gx: $00e9cfcde39d0b4a$export$881ce897a4237459,
      gy: $00e9cfcde39d0b4a$export$5056eb87f1daa9b4,
      g2x: $00e9cfcde39d0b4a$export$2cdfd364bfc1179f,
      g2y: $00e9cfcde39d0b4a$export$85e678c171039b5a,
      n: $00e9cfcde39d0b4a$export$7ccc53e8f1e7dfc5,
      h: $00e9cfcde39d0b4a$export$41b7b4fef7f76fa9,
      x: $00e9cfcde39d0b4a$export$d141bba7fdc215a3,
      k: $00e9cfcde39d0b4a$export$342063e11d6c3cad,
      sqrtN3: $00e9cfcde39d0b4a$export$985f9eea851ca5f9,
      sqrtN3m1o2: $00e9cfcde39d0b4a$export$3d2b20680da13ad6
    };
    var $3dc2627f1a74b978$exports = {};
    $parcel$export($3dc2627f1a74b978$exports, "frobCoeffs", () => $3dc2627f1a74b978$export$ef36a8205544c00e);
    $parcel$export($3dc2627f1a74b978$exports, "getFrobCoeff", () => $3dc2627f1a74b978$export$3fa013b223651431);
    var $3dc2627f1a74b978$export$ef36a8205544c00e = {
      "2,1,1": new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), -1n),
      "6,1,1": new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x1a0111ea397fe699ec02408663d4de85aa0d857d89759ad4897d29650fb85f9b409427eb4f49fffd8bfd00000000aaacn)),
      "6,1,2": new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x1a0111ea397fe699ec02408663d4de85aa0d857d89759ad4897d29650fb85f9b409427eb4f49fffd8bfd00000000aaadn), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n)),
      "6,2,1": new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x5f19672fdf76ce51ba69c6076a0f77eaddb3a93be6f89688de17d813620a00022e01fffffffefffen), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n)),
      "6,2,2": new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x1a0111ea397fe699ec02408663d4de85aa0d857d89759ad4897d29650fb85f9b409427eb4f49fffd8bfd00000000aaacn), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n)),
      "6,3,1": new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 1n)),
      "6,3,2": new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaaan), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n)),
      "6,4,1": new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x1a0111ea397fe699ec02408663d4de85aa0d857d89759ad4897d29650fb85f9b409427eb4f49fffd8bfd00000000aaacn), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n)),
      "6,4,2": new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x5f19672fdf76ce51ba69c6076a0f77eaddb3a93be6f89688de17d813620a00022e01fffffffefffen), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n)),
      "6,5,1": new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x5f19672fdf76ce51ba69c6076a0f77eaddb3a93be6f89688de17d813620a00022e01fffffffefffen)),
      "6,5,2": new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x5f19672fdf76ce51ba69c6076a0f77eaddb3a93be6f89688de17d813620a00022e01fffffffeffffn), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n)),
      "12,1,1": new (0, $f9eca204c73b879f$export$4b83d0846fa6fe37)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x1904d3bf02bb0667c231beb4202c0d1f0fd603fd3cbd5f4f7b2443d784bab9c4f67ea53d63e7813d8d0775ed92235fb8n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0xfc3e2b36c4e03288e9e902231f9fb854a14787b6c7b36fec0c8ec971f63c5f282d5ac14d6c7ec22cf78a126ddc4af3n)), new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n)), new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n))),
      "12,2,1": new (0, $f9eca204c73b879f$export$4b83d0846fa6fe37)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x5f19672fdf76ce51ba69c6076a0f77eaddb3a93be6f89688de17d813620a00022e01fffffffeffffn), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n)), new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n)), new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n))),
      "12,3,1": new (0, $f9eca204c73b879f$export$4b83d0846fa6fe37)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x135203e60180a68ee2e9c448d77a2cd91c3dedd930b1cf60ef396489f61eb45e304466cf3e67fa0af1ee7b04121bdea2n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x6af0e0437ff400b6831e36d6bd17ffe48395dabc2d3435e77f76e17009241c5ee67992f72ec05f4c81084fbede3cc09n)), new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n)), new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n))),
      "12,4,1": new (0, $f9eca204c73b879f$export$4b83d0846fa6fe37)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x5f19672fdf76ce51ba69c6076a0f77eaddb3a93be6f89688de17d813620a00022e01fffffffefffen), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n)), new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n)), new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n))),
      "12,5,1": new (0, $f9eca204c73b879f$export$4b83d0846fa6fe37)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x144e4211384586c16bd3ad4afa99cc9170df3560e77982d0db45f3536814f0bd5871c1908bd478cd1ee605167ff82995n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x5b2cfd9013a5fd8df47fa6b48b1e045f39816240c0b8fee8beadf4d8e9c0566c63a3e6e257f87329b18fae980078116n)), new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n)), new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n))),
      "12,6,1": new (0, $f9eca204c73b879f$export$4b83d0846fa6fe37)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaaan), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n)), new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n)), new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n))),
      "12,7,1": new (0, $f9eca204c73b879f$export$4b83d0846fa6fe37)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0xfc3e2b36c4e03288e9e902231f9fb854a14787b6c7b36fec0c8ec971f63c5f282d5ac14d6c7ec22cf78a126ddc4af3n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x1904d3bf02bb0667c231beb4202c0d1f0fd603fd3cbd5f4f7b2443d784bab9c4f67ea53d63e7813d8d0775ed92235fb8n)), new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n)), new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n))),
      "12,8,1": new (0, $f9eca204c73b879f$export$4b83d0846fa6fe37)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x1a0111ea397fe699ec02408663d4de85aa0d857d89759ad4897d29650fb85f9b409427eb4f49fffd8bfd00000000aaacn), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n)), new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n)), new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n))),
      "12,9,1": new (0, $f9eca204c73b879f$export$4b83d0846fa6fe37)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x6af0e0437ff400b6831e36d6bd17ffe48395dabc2d3435e77f76e17009241c5ee67992f72ec05f4c81084fbede3cc09n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x135203e60180a68ee2e9c448d77a2cd91c3dedd930b1cf60ef396489f61eb45e304466cf3e67fa0af1ee7b04121bdea2n)), new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n)), new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n))),
      "12,10,1": new (0, $f9eca204c73b879f$export$4b83d0846fa6fe37)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x1a0111ea397fe699ec02408663d4de85aa0d857d89759ad4897d29650fb85f9b409427eb4f49fffd8bfd00000000aaadn), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n)), new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n)), new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n))),
      "12,11,1": new (0, $f9eca204c73b879f$export$4b83d0846fa6fe37)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x5b2cfd9013a5fd8df47fa6b48b1e045f39816240c0b8fee8beadf4d8e9c0566c63a3e6e257f87329b18fae980078116n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x144e4211384586c16bd3ad4afa99cc9170df3560e77982d0db45f3536814f0bd5871c1908bd478cd1ee605167ff82995n)), new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n)), new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n)))
    };
    function $3dc2627f1a74b978$export$3fa013b223651431(extension, i, index) {
      return $3dc2627f1a74b978$export$ef36a8205544c00e[`${extension},${i},${index}`];
    }
    var $1d6ac6ce37d39979$exports = {};
    $parcel$export($1d6ac6ce37d39979$exports, "sha256", () => $1d6ac6ce37d39979$export$bced8d2aada2d1c9);
    $parcel$export($1d6ac6ce37d39979$exports, "sha512", () => $1d6ac6ce37d39979$export$a888d2532e6dc7bb);
    var $1d6ac6ce37d39979$export$bced8d2aada2d1c9 = {
      byteSize: 32,
      blockSize: 64,
      convert: (buffer) => {
        const hash = new (0, $parcel$interopDefault($fpZC2$jssha))("SHA-256", "UINT8ARRAY");
        hash.update(buffer);
        return hash.getHash("UINT8ARRAY");
      }
    };
    var $1d6ac6ce37d39979$export$a888d2532e6dc7bb = {
      byteSize: 64,
      blockSize: 128,
      convert: (buffer) => {
        const hash = new (0, $parcel$interopDefault($fpZC2$jssha))("SHA-512", "UINT8ARRAY");
        hash.update(buffer);
        return hash.getHash("UINT8ARRAY");
      }
    };
    var $8856e63c79a7a18e$exports = {};
    $parcel$export($8856e63c79a7a18e$exports, "xnum", () => $8856e63c79a7a18e$export$4c6c1dafe316d2c);
    $parcel$export($8856e63c79a7a18e$exports, "xden", () => $8856e63c79a7a18e$export$732ae2b2551ff413);
    $parcel$export($8856e63c79a7a18e$exports, "ynum", () => $8856e63c79a7a18e$export$ea2765eb3fc09cbc);
    $parcel$export($8856e63c79a7a18e$exports, "yden", () => $8856e63c79a7a18e$export$54826405639b5799);
    var $8856e63c79a7a18e$export$4c6c1dafe316d2c = [
      new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x5c759507e8e333ebb5b7a9a47d7ed8532c52d39fd3a042a88b58423c50ae15d5c2638e343d9c71c6238aaaaaaaa97d6n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x5c759507e8e333ebb5b7a9a47d7ed8532c52d39fd3a042a88b58423c50ae15d5c2638e343d9c71c6238aaaaaaaa97d6n)),
      new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x11560bf17baa99bc32126fced787c88f984f87adf7ae0c7f9a208c6b4f20a4181472aaa9cb8d555526a9ffffffffc71an)),
      new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x11560bf17baa99bc32126fced787c88f984f87adf7ae0c7f9a208c6b4f20a4181472aaa9cb8d555526a9ffffffffc71en), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x8ab05f8bdd54cde190937e76bc3e447cc27c3d6fbd7063fcd104635a790520c0a395554e5c6aaaa9354ffffffffe38dn)),
      new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x171d6541fa38ccfaed6dea691f5fb614cb14b4e7f4e810aa22d6108f142b85757098e38d0f671c7188e2aaaaaaaa5ed1n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n))
    ];
    var $8856e63c79a7a18e$export$732ae2b2551ff413 = [
      new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaa63n)),
      new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0xcn), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaa9fn)),
      new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 1n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n))
    ];
    var $8856e63c79a7a18e$export$ea2765eb3fc09cbc = [
      new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x1530477c7ab4113b59a4c18b076d11930f7da5d4a07f649bf54439d87d27e500fc8c25ebf8c92f6812cfc71c71c6d706n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x1530477c7ab4113b59a4c18b076d11930f7da5d4a07f649bf54439d87d27e500fc8c25ebf8c92f6812cfc71c71c6d706n)),
      new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x5c759507e8e333ebb5b7a9a47d7ed8532c52d39fd3a042a88b58423c50ae15d5c2638e343d9c71c6238aaaaaaaa97ben)),
      new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x11560bf17baa99bc32126fced787c88f984f87adf7ae0c7f9a208c6b4f20a4181472aaa9cb8d555526a9ffffffffc71cn), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x8ab05f8bdd54cde190937e76bc3e447cc27c3d6fbd7063fcd104635a790520c0a395554e5c6aaaa9354ffffffffe38fn)),
      new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x124c9ad43b6cf79bfbf7043de3811ad0761b0f37a1e26286b0e977c69aa274524e79097a56dc4bd9e1b371c71c718b10n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n))
    ];
    var $8856e63c79a7a18e$export$54826405639b5799 = [
      new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffa8fbn), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffa8fbn)),
      new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffa9d3n)),
      new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x12n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaa99n)),
      new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 1n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n))
    ];
    var $7114a315a435248d$exports = {};
    $parcel$export($7114a315a435248d$exports, "xi_2", () => $7114a315a435248d$export$8d1968de8a0388cb);
    $parcel$export($7114a315a435248d$exports, "Ell2p_a", () => $7114a315a435248d$export$cb23cd3dd580e72c);
    $parcel$export($7114a315a435248d$exports, "Ell2p_b", () => $7114a315a435248d$export$a49b3bf2a8f9ece3);
    $parcel$export($7114a315a435248d$exports, "ev1", () => $7114a315a435248d$export$c278e5ed08c0671a);
    $parcel$export($7114a315a435248d$exports, "ev2", () => $7114a315a435248d$export$f37125f5b41ac41c);
    $parcel$export($7114a315a435248d$exports, "ev3", () => $7114a315a435248d$export$8d0285e71910f92b);
    $parcel$export($7114a315a435248d$exports, "ev4", () => $7114a315a435248d$export$7fe9a0c81d3716fa);
    $parcel$export($7114a315a435248d$exports, "etas", () => $7114a315a435248d$export$dfed87f2d11110f4);
    var $7114a315a435248d$export$8d1968de8a0388cb = new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), -2n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), -1n));
    var $7114a315a435248d$export$cb23cd3dd580e72c = new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 240n));
    var $7114a315a435248d$export$a49b3bf2a8f9ece3 = new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 1012n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 1012n));
    var $7114a315a435248d$export$c278e5ed08c0671a = 0x699be3b8c6870965e5bf892ad5d2cc7b0e85a117402dfd83b7f4a947e02d978498255a2aaec0ac627b5afbdf1bf1c90n;
    var $7114a315a435248d$export$f37125f5b41ac41c = 0x8157cd83046453f5dd0972b6e3949e4288020b5b8a9cc99ca07e27089a2ce2436d965026adad3ef7baba37f2183e9b5n;
    var $7114a315a435248d$export$8d0285e71910f92b = 0xab1c2ffdd6c253ca155231eb3e71ba044fd562f6f72bc5bad5ec46a0b7a3b0247cf08ce6c6317f40edbc653a72dee17n;
    var $7114a315a435248d$export$7fe9a0c81d3716fa = 0xaa404866706722864480885d68ad0ccac1967c7544b447873cc37e0181271e006df72162a3d3e0287bf597fbf7f8fc1n;
    var $7114a315a435248d$export$dfed87f2d11110f4 = [
      new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), $7114a315a435248d$export$c278e5ed08c0671a), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), $7114a315a435248d$export$f37125f5b41ac41c)),
      new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), (0, $00e9cfcde39d0b4a$export$9e5f44173e64f162) - $7114a315a435248d$export$f37125f5b41ac41c), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), $7114a315a435248d$export$c278e5ed08c0671a)),
      new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), $7114a315a435248d$export$8d0285e71910f92b), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), $7114a315a435248d$export$7fe9a0c81d3716fa)),
      new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), (0, $00e9cfcde39d0b4a$export$9e5f44173e64f162) - $7114a315a435248d$export$7fe9a0c81d3716fa), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), $7114a315a435248d$export$8d0285e71910f92b))
    ];
    var $45c5a0c79e0736cc$exports = {};
    $parcel$export($45c5a0c79e0736cc$exports, "rv1", () => $45c5a0c79e0736cc$export$cd08e5dbcdd326bb);
    $parcel$export($45c5a0c79e0736cc$exports, "rootsOfUnity", () => $45c5a0c79e0736cc$export$5e60bb11dae8e64b);
    var $45c5a0c79e0736cc$export$cd08e5dbcdd326bb = 0x6af0e0437ff400b6831e36d6bd17ffe48395dabc2d3435e77f76e17009241c5ee67992f72ec05f4c81084fbede3cc09n;
    var $45c5a0c79e0736cc$export$5e60bb11dae8e64b = [
      new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 1n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n)),
      new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 0n), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 1n)),
      new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), $45c5a0c79e0736cc$export$cd08e5dbcdd326bb), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), $45c5a0c79e0736cc$export$cd08e5dbcdd326bb)),
      new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), $45c5a0c79e0736cc$export$cd08e5dbcdd326bb), new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), (0, $00e9cfcde39d0b4a$export$9e5f44173e64f162) - $45c5a0c79e0736cc$export$cd08e5dbcdd326bb))
    ];
    var $5f5e7634db6ec17d$exports = {};
    $parcel$export($5f5e7634db6ec17d$exports, "basicSchemeDst", () => $5f5e7634db6ec17d$export$c1bffad7aeda544b);
    $parcel$export($5f5e7634db6ec17d$exports, "augSchemeDst", () => $5f5e7634db6ec17d$export$5b346028b2eb430c);
    $parcel$export($5f5e7634db6ec17d$exports, "popSchemeDst", () => $5f5e7634db6ec17d$export$8d64a5ed43a5a57c);
    $parcel$export($5f5e7634db6ec17d$exports, "popSchemePopDst", () => $5f5e7634db6ec17d$export$b554d748bc2a5eef);
    var $5f5e7634db6ec17d$export$c1bffad7aeda544b = new TextEncoder().encode("BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_NUL_");
    var $5f5e7634db6ec17d$export$5b346028b2eb430c = new TextEncoder().encode("BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_AUG_");
    var $5f5e7634db6ec17d$export$8d64a5ed43a5a57c = new TextEncoder().encode("BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_");
    var $5f5e7634db6ec17d$export$b554d748bc2a5eef = new TextEncoder().encode("BLS_POP_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_");
    var $4508fd1f2dfd87e3$exports = {};
    $parcel$export($4508fd1f2dfd87e3$exports, "AffinePoint", () => $4508fd1f2dfd87e3$export$567266b06c239d21);
    var $4508fd1f2dfd87e3$export$567266b06c239d21 = class _$4508fd1f2dfd87e3$export$567266b06c239d21 {
      x;
      y;
      isInfinity;
      ec;
      constructor(x, y, isInfinity, ec = (0, $00e9cfcde39d0b4a$export$df72980aaa0ca402)) {
        this.x = x;
        this.y = y;
        this.isInfinity = isInfinity;
        this.ec = ec;
        (0, $8d5e30fd5fa02b49$export$a7a9523472993e97)(x instanceof y.constructor);
      }
      isOnCurve() {
        return this.isInfinity || this.y.multiply(this.y).equals(this.x.multiply(this.x).multiply(this.x).add(this.ec.a.multiply(this.x)).add(this.ec.b));
      }
      toJacobian() {
        return new (0, $f81fe8e548a259fc$export$54579cb87d860a47)(this.x, this.y, this.x.one(this.ec.q), this.isInfinity, this.ec);
      }
      twist() {
        const f = (0, $e01fe8766586be5e$export$d12e5c25403eca16).nil.one(this.ec.q);
        const wsq = new (0, $e01fe8766586be5e$export$d12e5c25403eca16)(this.ec.q, f.root, (0, $f9eca204c73b879f$export$4b83d0846fa6fe37).nil.zero(this.ec.q));
        const wcu = new (0, $e01fe8766586be5e$export$d12e5c25403eca16)(this.ec.q, (0, $f9eca204c73b879f$export$4b83d0846fa6fe37).nil.zero(this.ec.q), f.root);
        return new _$4508fd1f2dfd87e3$export$567266b06c239d21(this.x.multiply(wsq), this.y.multiply(wcu), false, this.ec);
      }
      untwist() {
        const f = (0, $e01fe8766586be5e$export$d12e5c25403eca16).nil.one(this.ec.q);
        const wsq = new (0, $e01fe8766586be5e$export$d12e5c25403eca16)(this.ec.q, f.root, (0, $f9eca204c73b879f$export$4b83d0846fa6fe37).nil.zero(this.ec.q));
        const wcu = new (0, $e01fe8766586be5e$export$d12e5c25403eca16)(this.ec.q, (0, $f9eca204c73b879f$export$4b83d0846fa6fe37).nil.zero(this.ec.q), f.root);
        return new _$4508fd1f2dfd87e3$export$567266b06c239d21(this.x.divide(wsq), this.y.divide(wcu), false, this.ec);
      }
      double() {
        const left = this.x.multiply(this.x).multiply(new (0, $61122e18a0bc5a58$export$312db8bf004879ae)(this.ec.q, 3n)).add(this.ec.a);
        const s = left.divide(this.y.multiply(new (0, $61122e18a0bc5a58$export$312db8bf004879ae)(this.ec.q, 2n)));
        const newX = s.multiply(s).subtract(this.x).subtract(this.x);
        const newY = s.multiply(this.x.subtract(newX)).subtract(this.y);
        return new _$4508fd1f2dfd87e3$export$567266b06c239d21(newX, newY, false, this.ec);
      }
      add(value) {
        (0, $8d5e30fd5fa02b49$export$a7a9523472993e97)(this.isOnCurve());
        (0, $8d5e30fd5fa02b49$export$a7a9523472993e97)(value.isOnCurve());
        if (this.isInfinity) return value;
        else if (value.isInfinity) return this;
        else if (this.equals(value)) return this.double();
        const s = value.y.subtract(this.y).divide(value.x.subtract(this.x));
        const newX = s.multiply(s).subtract(this.x).subtract(value.x);
        const newY = s.multiply(this.x.subtract(newX)).subtract(this.y);
        return new _$4508fd1f2dfd87e3$export$567266b06c239d21(newX, newY, false, this.ec);
      }
      subtract(value) {
        return this.add(value.negate());
      }
      multiply(value) {
        return (0, $27314bc03f74868b$export$6fc8005fc3e0ffe8)(value, this.toJacobian(), this.ec).toAffine();
      }
      negate() {
        return new _$4508fd1f2dfd87e3$export$567266b06c239d21(this.x, this.y.negate(), this.isInfinity, this.ec);
      }
      equals(value) {
        return this.x.equals(value.x) && this.y.equals(value.y) && this.isInfinity === value.isInfinity;
      }
      clone() {
        return new _$4508fd1f2dfd87e3$export$567266b06c239d21(this.x.clone(), this.y.clone(), this.isInfinity, this.ec);
      }
      toString() {
        return `AffinePoint(x=${this.x}, y=${this.y}, i=${this.isInfinity})`;
      }
    };
    var $6855b0e4fef0dbbe$exports = {};
    var $f81fe8e548a259fc$exports = {};
    $parcel$export($f81fe8e548a259fc$exports, "JacobianPoint", () => $f81fe8e548a259fc$export$54579cb87d860a47);
    var $f81fe8e548a259fc$export$54579cb87d860a47 = class _$f81fe8e548a259fc$export$54579cb87d860a47 {
      x;
      y;
      z;
      isInfinity;
      ec;
      static fromBytes(bytes, isExtension, ec = (0, $00e9cfcde39d0b4a$export$df72980aaa0ca402)) {
        const provider = isExtension ? (0, $ee4c81c840b9d78d$export$3250f1bd1b840331) : (0, $61122e18a0bc5a58$export$312db8bf004879ae);
        if (isExtension) {
          if (bytes.length !== 96) throw new Error("Expected 96 bytes.");
        } else {
          if (bytes.length !== 48) throw new Error("Expected 48 bytes.");
        }
        const mByte = bytes[0] & 224;
        if ([
          32,
          96,
          224
        ].includes(mByte)) throw new Error("Invalid first three bits.");
        const compressed = (mByte & 128) !== 0;
        const infinity = (mByte & 64) !== 0;
        const signed = (mByte & 32) !== 0;
        if (!compressed) throw new Error("Compression bit must be 1.");
        bytes[0] &= 31;
        if (infinity) {
          for (const byte of bytes) {
            if (byte !== 0) throw new Error("Point at infinity, but found non-zero byte.");
          }
          return new (0, $4508fd1f2dfd87e3$export$567266b06c239d21)(provider.nil.zero(ec.q), provider.nil.zero(ec.q), true, ec).toJacobian();
        }
        const x = (isExtension ? (0, $ee4c81c840b9d78d$export$3250f1bd1b840331) : (0, $61122e18a0bc5a58$export$312db8bf004879ae)).nil.fromBytes(ec.q, bytes);
        const yValue = (0, $27314bc03f74868b$export$c28dd39fe7cf1942)(x, ec);
        const sign = isExtension ? (0, $27314bc03f74868b$export$1f050984502bf9f6)(yValue, ec) : (0, $27314bc03f74868b$export$42e585c8f08aa7c5)(yValue, ec);
        const y = sign === signed ? yValue : yValue.negate();
        return new (0, $4508fd1f2dfd87e3$export$567266b06c239d21)(x, y, false, ec).toJacobian();
      }
      static fromHex(hex, isExtension, ec = (0, $00e9cfcde39d0b4a$export$df72980aaa0ca402)) {
        return _$f81fe8e548a259fc$export$54579cb87d860a47.fromBytes((0, $11b8831ba7e63616$export$1a8ceedbd5845648)(hex), isExtension, ec);
      }
      static generateG1() {
        return new (0, $4508fd1f2dfd87e3$export$567266b06c239d21)((0, $00e9cfcde39d0b4a$export$df72980aaa0ca402).gx, (0, $00e9cfcde39d0b4a$export$df72980aaa0ca402).gy, false, (0, $00e9cfcde39d0b4a$export$df72980aaa0ca402)).toJacobian();
      }
      static generateG2() {
        return new (0, $4508fd1f2dfd87e3$export$567266b06c239d21)((0, $00e9cfcde39d0b4a$export$89bff894721071da).g2x, (0, $00e9cfcde39d0b4a$export$89bff894721071da).g2y, false, (0, $00e9cfcde39d0b4a$export$89bff894721071da)).toJacobian();
      }
      static infinityG1(isExtension = false) {
        const provider = isExtension ? (0, $ee4c81c840b9d78d$export$3250f1bd1b840331) : (0, $61122e18a0bc5a58$export$312db8bf004879ae);
        return new _$f81fe8e548a259fc$export$54579cb87d860a47(provider.nil.zero((0, $00e9cfcde39d0b4a$export$df72980aaa0ca402).q), provider.nil.zero((0, $00e9cfcde39d0b4a$export$df72980aaa0ca402).q), provider.nil.zero((0, $00e9cfcde39d0b4a$export$df72980aaa0ca402).q), true, (0, $00e9cfcde39d0b4a$export$df72980aaa0ca402));
      }
      static infinityG2(isExtension = true) {
        const provider = isExtension ? (0, $ee4c81c840b9d78d$export$3250f1bd1b840331) : (0, $61122e18a0bc5a58$export$312db8bf004879ae);
        return new _$f81fe8e548a259fc$export$54579cb87d860a47(provider.nil.zero((0, $00e9cfcde39d0b4a$export$89bff894721071da).q), provider.nil.zero((0, $00e9cfcde39d0b4a$export$89bff894721071da).q), provider.nil.zero((0, $00e9cfcde39d0b4a$export$89bff894721071da).q), true, (0, $00e9cfcde39d0b4a$export$89bff894721071da));
      }
      static fromBytesG1(bytes, isExtension = false) {
        return _$f81fe8e548a259fc$export$54579cb87d860a47.fromBytes(bytes, isExtension, (0, $00e9cfcde39d0b4a$export$df72980aaa0ca402));
      }
      static fromBytesG2(bytes, isExtension = true) {
        return _$f81fe8e548a259fc$export$54579cb87d860a47.fromBytes(bytes, isExtension, (0, $00e9cfcde39d0b4a$export$89bff894721071da));
      }
      static fromHexG1(hex, isExtension = false) {
        return _$f81fe8e548a259fc$export$54579cb87d860a47.fromBytesG1((0, $11b8831ba7e63616$export$1a8ceedbd5845648)(hex), isExtension);
      }
      static fromHexG2(hex, isExtension = true) {
        return _$f81fe8e548a259fc$export$54579cb87d860a47.fromBytesG2((0, $11b8831ba7e63616$export$1a8ceedbd5845648)(hex), isExtension);
      }
      constructor(x, y, z, isInfinity, ec = (0, $00e9cfcde39d0b4a$export$df72980aaa0ca402)) {
        this.x = x;
        this.y = y;
        this.z = z;
        this.isInfinity = isInfinity;
        this.ec = ec;
        (0, $8d5e30fd5fa02b49$export$a7a9523472993e97)(x instanceof y.constructor);
        (0, $8d5e30fd5fa02b49$export$a7a9523472993e97)(y instanceof z.constructor);
      }
      isOnCurve() {
        return this.isInfinity || this.toAffine().isOnCurve();
      }
      isValid() {
        return this.isOnCurve() && this.multiply(this.ec.n).equals(this.x instanceof (0, $61122e18a0bc5a58$export$312db8bf004879ae) ? _$f81fe8e548a259fc$export$54579cb87d860a47.infinityG1() : _$f81fe8e548a259fc$export$54579cb87d860a47.infinityG2());
      }
      getFingerprint() {
        const bytes = this.toBytes();
        return (0, $11b8831ba7e63616$export$b25202b2d7056da9)((0, $20b42468fafd22ce$export$699b481075cb9e0d)(bytes).slice(0, 4), "big");
      }
      toAffine() {
        return this.isInfinity ? new (0, $4508fd1f2dfd87e3$export$567266b06c239d21)(this.x.zero(this.ec.q), this.y.zero(this.ec.q), true, this.ec) : new (0, $4508fd1f2dfd87e3$export$567266b06c239d21)(this.x.divide(this.z.pow(2n)), this.y.divide(this.z.pow(3n)), false, this.ec);
      }
      toBytes() {
        const point = this.toAffine();
        const output = point.x.toBytes();
        if (point.isInfinity) {
          const bytes = [
            192
          ];
          for (let i = 0; i < output.length - 1; i++) bytes.push(0);
          return Uint8Array.from(bytes);
        }
        const sign = point.y instanceof (0, $ee4c81c840b9d78d$export$3250f1bd1b840331) ? (0, $27314bc03f74868b$export$1f050984502bf9f6)(point.y, this.ec) : (0, $27314bc03f74868b$export$42e585c8f08aa7c5)(point.y, this.ec);
        output[0] |= sign ? 160 : 128;
        return output;
      }
      toHex() {
        return (0, $11b8831ba7e63616$export$7ea66e3774a60b67)(this.toBytes());
      }
      toString() {
        return `JacobianPoint(x=${this.x}, y=${this.y}, z=${this.z}, i=${this.isInfinity})`;
      }
      double() {
        if (this.isInfinity || this.y.equals(this.x.zero(this.ec.q))) return new _$f81fe8e548a259fc$export$54579cb87d860a47(this.x.one(this.ec.q), this.x.one(this.ec.q), this.x.zero(this.ec.q), true, this.ec);
        const S = this.x.multiply(this.y).multiply(this.y).multiply(new (0, $61122e18a0bc5a58$export$312db8bf004879ae)(this.ec.q, 4n));
        const Z_sq = this.z.multiply(this.z);
        const Z_4th = Z_sq.multiply(Z_sq);
        const Y_sq = this.y.multiply(this.y);
        const Y_4th = Y_sq.multiply(Y_sq);
        const M = this.x.multiply(this.x).multiply(new (0, $61122e18a0bc5a58$export$312db8bf004879ae)(this.ec.q, 3n)).add(this.ec.a.multiply(Z_4th));
        const X_p = M.multiply(M).subtract(S.multiply(new (0, $61122e18a0bc5a58$export$312db8bf004879ae)(this.ec.q, 2n)));
        const Y_p = M.multiply(S.subtract(X_p)).subtract(Y_4th.multiply(new (0, $61122e18a0bc5a58$export$312db8bf004879ae)(this.ec.q, 8n)));
        const Z_p = this.y.multiply(this.z).multiply(new (0, $61122e18a0bc5a58$export$312db8bf004879ae)(this.ec.q, 2n));
        return new _$f81fe8e548a259fc$export$54579cb87d860a47(X_p, Y_p, Z_p, false, this.ec);
      }
      negate() {
        return this.toAffine().negate().toJacobian();
      }
      add(value) {
        if (this.isInfinity) return value;
        else if (value.isInfinity) return this;
        const U1 = this.x.multiply(value.z.pow(2n));
        const U2 = value.x.multiply(this.z.pow(2n));
        const S1 = this.y.multiply(value.z.pow(3n));
        const S2 = value.y.multiply(this.z.pow(3n));
        if (U1.equals(U2)) {
          if (!S1.equals(S2)) return new _$f81fe8e548a259fc$export$54579cb87d860a47(this.x.one(this.ec.q), this.x.one(this.ec.q), this.x.zero(this.ec.q), true, this.ec);
          else return this.double();
        }
        const H = U2.subtract(U1);
        const R = S2.subtract(S1);
        const H_sq = H.multiply(H);
        const H_cu = H.multiply(H_sq);
        const X3 = R.multiply(R).subtract(H_cu).subtract(U1.multiply(H_sq).multiply(new (0, $61122e18a0bc5a58$export$312db8bf004879ae)(this.ec.q, 2n)));
        const Y3 = R.multiply(U1.multiply(H_sq).subtract(X3)).subtract(S1.multiply(H_cu));
        const Z3 = H.multiply(this.z).multiply(value.z);
        return new _$f81fe8e548a259fc$export$54579cb87d860a47(X3, Y3, Z3, false, this.ec);
      }
      multiply(value) {
        return (0, $27314bc03f74868b$export$6fc8005fc3e0ffe8)(value, this, this.ec);
      }
      equals(value) {
        return this.toAffine().equals(value.toAffine());
      }
      clone() {
        return new _$f81fe8e548a259fc$export$54579cb87d860a47(this.x.clone(), this.y.clone(), this.z.clone(), this.isInfinity, this.ec);
      }
    };
    var $652b9d23a743e8c2$exports = {};
    $parcel$export($652b9d23a743e8c2$exports, "OperatorError", () => $652b9d23a743e8c2$export$b279dc3e096c808b);
    var $652b9d23a743e8c2$export$b279dc3e096c808b = class _$652b9d23a743e8c2$export$b279dc3e096c808b extends Error {
      constructor(message) {
        super(message);
        Object.setPrototypeOf(this, _$652b9d23a743e8c2$export$b279dc3e096c808b.prototype);
      }
    };
    var $8d5e30fd5fa02b49$exports = {};
    $parcel$export($8d5e30fd5fa02b49$exports, "AssertionError", () => $8d5e30fd5fa02b49$export$7750cdfb4db2c3d);
    $parcel$export($8d5e30fd5fa02b49$exports, "assert", () => $8d5e30fd5fa02b49$export$a7a9523472993e97);
    var $8d5e30fd5fa02b49$export$7750cdfb4db2c3d = class _$8d5e30fd5fa02b49$export$7750cdfb4db2c3d extends Error {
      constructor(message) {
        super(message);
        Object.setPrototypeOf(this, _$8d5e30fd5fa02b49$export$7750cdfb4db2c3d.prototype);
      }
    };
    function $8d5e30fd5fa02b49$export$a7a9523472993e97(test, message = "Assertion failed.") {
      if (!test) throw new $8d5e30fd5fa02b49$export$7750cdfb4db2c3d(message);
    }
    var $d8b9abe285040e16$exports = {};
    var $b7fd6731762bdca0$exports = {};
    $parcel$export($b7fd6731762bdca0$exports, "PrivateKey", () => $b7fd6731762bdca0$export$8f54525b330fd87b);
    var $b7fd6731762bdca0$export$8f54525b330fd87b = class _$b7fd6731762bdca0$export$8f54525b330fd87b {
      value;
      static size = 32;
      static fromBytes(bytes) {
        return new _$b7fd6731762bdca0$export$8f54525b330fd87b((0, $013cd1e91a5ae572$export$842a2cf37af977e1)((0, $11b8831ba7e63616$export$2a52511e4f35930a)(bytes, "big"), (0, $00e9cfcde39d0b4a$export$df72980aaa0ca402).n));
      }
      static fromHex(hex) {
        return _$b7fd6731762bdca0$export$8f54525b330fd87b.fromBytes((0, $11b8831ba7e63616$export$1a8ceedbd5845648)(hex));
      }
      static fromSeed(seed) {
        const length = 48;
        const okm = (0, $5758ad345f58e7ac$export$c0375ac2990d2f65)(length, Uint8Array.from([
          ...seed,
          0
        ]), new TextEncoder().encode("BLS-SIG-KEYGEN-SALT-"), Uint8Array.from([
          0,
          length
        ]));
        return new _$b7fd6731762bdca0$export$8f54525b330fd87b((0, $013cd1e91a5ae572$export$842a2cf37af977e1)((0, $11b8831ba7e63616$export$2a52511e4f35930a)(okm, "big"), (0, $00e9cfcde39d0b4a$export$df72980aaa0ca402).n));
      }
      static fromBigInt(value) {
        return new _$b7fd6731762bdca0$export$8f54525b330fd87b((0, $013cd1e91a5ae572$export$842a2cf37af977e1)(value, (0, $00e9cfcde39d0b4a$export$df72980aaa0ca402).n));
      }
      static aggregate(privateKeys) {
        return new _$b7fd6731762bdca0$export$8f54525b330fd87b((0, $013cd1e91a5ae572$export$842a2cf37af977e1)(privateKeys.reduce((aggregate, privateKey) => aggregate + privateKey.value, 0n), (0, $00e9cfcde39d0b4a$export$df72980aaa0ca402).n));
      }
      constructor(value) {
        this.value = value;
        (0, $8d5e30fd5fa02b49$export$a7a9523472993e97)(value < (0, $00e9cfcde39d0b4a$export$df72980aaa0ca402).n);
      }
      getG1() {
        return (0, $f81fe8e548a259fc$export$54579cb87d860a47).generateG1().multiply(this.value);
      }
      toBytes() {
        return (0, $11b8831ba7e63616$export$c0f6630717bc20c7)(this.value, _$b7fd6731762bdca0$export$8f54525b330fd87b.size, "big");
      }
      toHex() {
        return (0, $11b8831ba7e63616$export$7ea66e3774a60b67)(this.toBytes());
      }
      toString() {
        return `PrivateKey(0x${this.toHex()})`;
      }
      equals(value) {
        return this.value === value.value;
      }
    };
    var $46e980308398850e$exports = {};
    $parcel$export($46e980308398850e$exports, "AugSchemeMPL", () => $46e980308398850e$export$11fa5fadc101995e);
    var $46e980308398850e$export$11fa5fadc101995e = class {
      static keyGen(seed) {
        return (0, $6263a241ee4922bd$export$6b169d3865731b08)(seed);
      }
      static sign(privateKey, message) {
        const publicKey = privateKey.getG1();
        return (0, $e66c6c730aa32243$export$d36c55300691c9bd)(privateKey, Uint8Array.from([
          ...publicKey.toBytes(),
          ...message
        ]), (0, $5f5e7634db6ec17d$export$5b346028b2eb430c));
      }
      static sign_prepend(privateKey, message, prependPublicKey) {
        return (0, $e66c6c730aa32243$export$d36c55300691c9bd)(privateKey, Uint8Array.from([
          ...prependPublicKey.toBytes(),
          ...message
        ]), (0, $5f5e7634db6ec17d$export$5b346028b2eb430c));
      }
      static verify(publicKey, message, signature) {
        return (0, $e66c6c730aa32243$export$fa86e59803ac4685)(publicKey, Uint8Array.from([
          ...publicKey.toBytes(),
          ...message
        ]), signature, (0, $5f5e7634db6ec17d$export$5b346028b2eb430c));
      }
      static aggregate(signatures) {
        return (0, $e66c6c730aa32243$export$58639efa77ac2d9c)(signatures);
      }
      static aggregateVerify(publicKeys, messages, signature) {
        if (publicKeys.length !== messages.length || !publicKeys.length) return false;
        const mPrimes = [];
        for (let i = 0; i < publicKeys.length; i++) mPrimes.push(Uint8Array.from([
          ...publicKeys[i].toBytes(),
          ...messages[i]
        ]));
        return (0, $e66c6c730aa32243$export$6d85de9d133db9bf)(publicKeys, mPrimes, signature, (0, $5f5e7634db6ec17d$export$5b346028b2eb430c));
      }
      static deriveChildSk(privateKey, index) {
        return (0, $6263a241ee4922bd$export$5db2ff97ac93f09f)(privateKey, index);
      }
      static deriveChildSkUnhardened(privateKey, index) {
        return (0, $6263a241ee4922bd$export$3d98d96efbfaa93e)(privateKey, index);
      }
      static deriveChildPkUnhardened(publicKey, index) {
        return (0, $6263a241ee4922bd$export$5c5df4dc4bd00c4c)(publicKey, index);
      }
    };
    var $cbd8901008cf0b7e$exports = {};
    $parcel$export($cbd8901008cf0b7e$exports, "BasicSchemeMPL", () => $cbd8901008cf0b7e$export$4eba737f59c212f9);
    var $cbd8901008cf0b7e$export$4eba737f59c212f9 = class {
      static keyGen(seed) {
        return (0, $6263a241ee4922bd$export$6b169d3865731b08)(seed);
      }
      static sign(privateKey, message) {
        return (0, $e66c6c730aa32243$export$d36c55300691c9bd)(privateKey, message, (0, $5f5e7634db6ec17d$export$c1bffad7aeda544b));
      }
      static verify(publicKey, message, signature) {
        return (0, $e66c6c730aa32243$export$fa86e59803ac4685)(publicKey, message, signature, (0, $5f5e7634db6ec17d$export$c1bffad7aeda544b));
      }
      static aggregate(signatures) {
        return (0, $e66c6c730aa32243$export$58639efa77ac2d9c)(signatures);
      }
      static aggregateVerify(publicKeys, messages, signature) {
        if (publicKeys.length !== messages.length || !publicKeys.length) return false;
        for (const message of messages) for (const match of messages) {
          if (message !== match && (0, $11b8831ba7e63616$export$c663ab80cce302c5)(message, match)) return false;
        }
        return (0, $e66c6c730aa32243$export$6d85de9d133db9bf)(publicKeys, messages, signature, (0, $5f5e7634db6ec17d$export$c1bffad7aeda544b));
      }
      static deriveChildSk(privateKey, index) {
        return (0, $6263a241ee4922bd$export$5db2ff97ac93f09f)(privateKey, index);
      }
      static deriveChildSkUnhardened(privateKey, index) {
        return (0, $6263a241ee4922bd$export$3d98d96efbfaa93e)(privateKey, index);
      }
      static deriveChildPkUnhardened(publicKey, index) {
        return (0, $6263a241ee4922bd$export$5c5df4dc4bd00c4c)(publicKey, index);
      }
    };
    var $c20e836927ce4374$exports = {};
    $parcel$export($c20e836927ce4374$exports, "PopSchemeMPL", () => $c20e836927ce4374$export$b768295c529d6107);
    var $c20e836927ce4374$export$b768295c529d6107 = class {
      static keyGen(seed) {
        return (0, $6263a241ee4922bd$export$6b169d3865731b08)(seed);
      }
      static sign(privateKey, message) {
        return (0, $e66c6c730aa32243$export$d36c55300691c9bd)(privateKey, message, (0, $5f5e7634db6ec17d$export$8d64a5ed43a5a57c));
      }
      static verify(publicKey, message, signature) {
        return (0, $e66c6c730aa32243$export$fa86e59803ac4685)(publicKey, message, signature, (0, $5f5e7634db6ec17d$export$8d64a5ed43a5a57c));
      }
      static aggregate(signatures) {
        return (0, $e66c6c730aa32243$export$58639efa77ac2d9c)(signatures);
      }
      static aggregateVerify(publicKeys, messages, signature) {
        if (publicKeys.length !== messages.length || !publicKeys.length) return false;
        for (const message of messages) for (const match of messages) {
          if (message !== match && (0, $11b8831ba7e63616$export$c663ab80cce302c5)(message, match)) return false;
        }
        return (0, $e66c6c730aa32243$export$6d85de9d133db9bf)(publicKeys, messages, signature, (0, $5f5e7634db6ec17d$export$8d64a5ed43a5a57c));
      }
      static popProve(privateKey) {
        const publicKey = privateKey.getG1();
        return (0, $8c194b1bdb7378af$export$74473883de6345ad)(publicKey.toBytes(), (0, $5f5e7634db6ec17d$export$b554d748bc2a5eef)).multiply(privateKey.value);
      }
      static popVerify(publicKey, proof) {
        try {
          (0, $8d5e30fd5fa02b49$export$a7a9523472993e97)(proof.isValid());
          (0, $8d5e30fd5fa02b49$export$a7a9523472993e97)(publicKey.isValid());
          const q = (0, $8c194b1bdb7378af$export$74473883de6345ad)(publicKey.toBytes(), (0, $5f5e7634db6ec17d$export$b554d748bc2a5eef));
          const one = (0, $e01fe8766586be5e$export$d12e5c25403eca16).nil.one((0, $00e9cfcde39d0b4a$export$df72980aaa0ca402).q);
          const pairingResult = (0, $18de921ac0e3bf52$export$18b00e9902a9edab)([
            publicKey,
            (0, $f81fe8e548a259fc$export$54579cb87d860a47).generateG1().negate()
          ], [
            q,
            proof
          ]);
          return pairingResult.equals(one);
        } catch (e) {
          if (e instanceof (0, $8d5e30fd5fa02b49$export$7750cdfb4db2c3d)) return false;
          throw e;
        }
      }
      static fastAggregateVerify(publicKeys, message, signature) {
        if (!publicKeys.length) return false;
        let aggregate = publicKeys[0];
        for (const publicKey of publicKeys.slice(1)) aggregate = aggregate.add(publicKey);
        return (0, $e66c6c730aa32243$export$fa86e59803ac4685)(aggregate, message, signature, (0, $5f5e7634db6ec17d$export$8d64a5ed43a5a57c));
      }
      static deriveChildSk(privateKey, index) {
        return (0, $6263a241ee4922bd$export$5db2ff97ac93f09f)(privateKey, index);
      }
      static deriveChildSkUnhardened(privateKey, index) {
        return (0, $6263a241ee4922bd$export$3d98d96efbfaa93e)(privateKey, index);
      }
      static deriveChildPkUnhardened(publicKey, index) {
        return (0, $6263a241ee4922bd$export$5c5df4dc4bd00c4c)(publicKey, index);
      }
    };
    var $11b8831ba7e63616$exports = {};
    $parcel$export($11b8831ba7e63616$exports, "flip", () => $11b8831ba7e63616$export$8a83211c878a3f1f);
    $parcel$export($11b8831ba7e63616$exports, "intBitLength", () => $11b8831ba7e63616$export$750ad761648c1996);
    $parcel$export($11b8831ba7e63616$exports, "bigIntBitLength", () => $11b8831ba7e63616$export$311832b55488d870);
    $parcel$export($11b8831ba7e63616$exports, "bigIntToBits", () => $11b8831ba7e63616$export$59537329b9c511e9);
    $parcel$export($11b8831ba7e63616$exports, "intToBits", () => $11b8831ba7e63616$export$98328bcdfd55e72d);
    $parcel$export($11b8831ba7e63616$exports, "intToBytes", () => $11b8831ba7e63616$export$7f883c9b3dcb5103);
    $parcel$export($11b8831ba7e63616$exports, "bytesToInt", () => $11b8831ba7e63616$export$b25202b2d7056da9);
    $parcel$export($11b8831ba7e63616$exports, "encodeInt", () => $11b8831ba7e63616$export$28bc1625998ce845);
    $parcel$export($11b8831ba7e63616$exports, "decodeInt", () => $11b8831ba7e63616$export$2046d9d5fd83c6e2);
    $parcel$export($11b8831ba7e63616$exports, "bigIntToBytes", () => $11b8831ba7e63616$export$c0f6630717bc20c7);
    $parcel$export($11b8831ba7e63616$exports, "bytesToBigInt", () => $11b8831ba7e63616$export$2a52511e4f35930a);
    $parcel$export($11b8831ba7e63616$exports, "encodeBigInt", () => $11b8831ba7e63616$export$2797dcbce5606dae);
    $parcel$export($11b8831ba7e63616$exports, "decodeBigInt", () => $11b8831ba7e63616$export$630067042493230b);
    $parcel$export($11b8831ba7e63616$exports, "concatBytes", () => $11b8831ba7e63616$export$287dd7971339c972);
    $parcel$export($11b8831ba7e63616$exports, "bytesEqual", () => $11b8831ba7e63616$export$c663ab80cce302c5);
    $parcel$export($11b8831ba7e63616$exports, "toHex", () => $11b8831ba7e63616$export$7ea66e3774a60b67);
    $parcel$export($11b8831ba7e63616$exports, "fromHex", () => $11b8831ba7e63616$export$1a8ceedbd5845648);
    function $11b8831ba7e63616$export$8a83211c878a3f1f(binary) {
      return binary.replace(/[01]/g, (match) => match === "0" ? "1" : "0");
    }
    function $11b8831ba7e63616$export$750ad761648c1996(value) {
      return Math.abs(value).toString(2).length;
    }
    function $11b8831ba7e63616$export$311832b55488d870(value) {
      return (value < 0n ? -value : value).toString(2).length;
    }
    function $11b8831ba7e63616$export$59537329b9c511e9(i) {
      if (i < 1n) return [
        0
      ];
      const bits = [];
      while (i !== 0n) {
        bits.push(Number((0, $013cd1e91a5ae572$export$842a2cf37af977e1)(i, 2n)));
        i /= 2n;
      }
      return bits.reverse();
    }
    function $11b8831ba7e63616$export$98328bcdfd55e72d(i) {
      if (i < 1) return [
        0
      ];
      const bits = [];
      while (i !== 0) {
        bits.push(Number((0, $013cd1e91a5ae572$export$64b58c5b0372ae95)(i, 2)));
        i /= 2;
      }
      return bits.reverse();
    }
    function $11b8831ba7e63616$export$7f883c9b3dcb5103(value, size, endian, signed = false) {
      if (value < 0 && !signed) throw new Error("Cannot convert negative number to unsigned.");
      if (Math.floor(value) !== value) throw new Error("Cannot convert floating point number.");
      let binary = Math.abs(value).toString(2).padStart(size * 8, "0");
      if (value < 0) binary = (parseInt($11b8831ba7e63616$export$8a83211c878a3f1f(binary), 2) + 1).toString(2).padStart(size * 8, "0");
      var bytes = binary.match(/[01]{8}/g).map((match) => parseInt(match, 2));
      if (endian === "little") bytes.reverse();
      return Uint8Array.from(bytes);
    }
    function $11b8831ba7e63616$export$b25202b2d7056da9(bytes, endian, signed = false) {
      if (bytes.length === 0) return 0;
      const sign = bytes[endian === "little" ? bytes.length - 1 : 0].toString(2).padStart(8, "0")[0];
      const byteList = endian === "little" ? bytes.reverse() : bytes;
      let binary = "";
      for (const byte of byteList) binary += byte.toString(2).padStart(8, "0");
      if (sign === "1" && signed) binary = (parseInt($11b8831ba7e63616$export$8a83211c878a3f1f(binary), 2) + 1).toString(2).padStart(bytes.length * 8, "0");
      const result = parseInt(binary, 2);
      return sign === "1" && signed ? -result : result;
    }
    function $11b8831ba7e63616$export$28bc1625998ce845(value) {
      if (value === 0) return Uint8Array.from([]);
      const length = $11b8831ba7e63616$export$750ad761648c1996(value) + 8 >> 3;
      let bytes = $11b8831ba7e63616$export$7f883c9b3dcb5103(value, length, "big", true);
      while (bytes.length > 1 && bytes[0] === ((bytes[1] & 128) !== 0 ? 255 : 0)) bytes = bytes.slice(1);
      return bytes;
    }
    function $11b8831ba7e63616$export$2046d9d5fd83c6e2(bytes) {
      return $11b8831ba7e63616$export$b25202b2d7056da9(bytes, "big", true);
    }
    function $11b8831ba7e63616$export$c0f6630717bc20c7(value, size, endian, signed = false) {
      if (value < 0n && !signed) throw new Error("Cannot convert negative number to unsigned.");
      let binary = (value < 0n ? -value : value).toString(2).padStart(size * 8, "0");
      if (value < 0) binary = (BigInt("0b" + $11b8831ba7e63616$export$8a83211c878a3f1f(binary)) + 1n).toString(2).padStart(size * 8, "0");
      var bytes = binary.match(/[01]{8}/g).map((match) => parseInt(match, 2));
      if (endian === "little") bytes.reverse();
      return Uint8Array.from(bytes);
    }
    function $11b8831ba7e63616$export$2a52511e4f35930a(bytes, endian, signed = false) {
      if (bytes.length === 0) return 0n;
      const sign = bytes[endian === "little" ? bytes.length - 1 : 0].toString(2).padStart(8, "0")[0];
      const byteList = endian === "little" ? bytes.reverse() : bytes;
      let binary = "";
      for (const byte of byteList) binary += byte.toString(2).padStart(8, "0");
      if (sign === "1" && signed) binary = (BigInt("0b" + $11b8831ba7e63616$export$8a83211c878a3f1f(binary)) + 1n).toString(2).padStart(bytes.length * 8, "0");
      const result = BigInt("0b" + binary);
      return sign === "1" && signed ? -result : result;
    }
    function $11b8831ba7e63616$export$2797dcbce5606dae(value) {
      if (value === 0n) return Uint8Array.from([]);
      const length = $11b8831ba7e63616$export$311832b55488d870(value) + 8 >> 3;
      let bytes = $11b8831ba7e63616$export$c0f6630717bc20c7(value, length, "big", true);
      while (bytes.length > 1 && bytes[0] === ((bytes[1] & 128) !== 0 ? 255 : 0)) bytes = bytes.slice(1);
      return bytes;
    }
    function $11b8831ba7e63616$export$630067042493230b(bytes) {
      return $11b8831ba7e63616$export$2a52511e4f35930a(bytes, "big", true);
    }
    function $11b8831ba7e63616$export$287dd7971339c972(...lists) {
      const bytes = [];
      for (const list of lists) for (const byte of list) bytes.push(byte);
      return Uint8Array.from(bytes);
    }
    function $11b8831ba7e63616$export$c663ab80cce302c5(a, b) {
      return a.length === b.length && a.findIndex((byte, i) => b[i] !== byte) === -1;
    }
    var $11b8831ba7e63616$var$HEX_STRINGS = "0123456789abcdef";
    var $11b8831ba7e63616$var$MAP_HEX = {
      "0": 0,
      "1": 1,
      "2": 2,
      "3": 3,
      "4": 4,
      "5": 5,
      "6": 6,
      "7": 7,
      "8": 8,
      "9": 9,
      a: 10,
      b: 11,
      c: 12,
      d: 13,
      e: 14,
      f: 15,
      A: 10,
      B: 11,
      C: 12,
      D: 13,
      E: 14,
      F: 15
    };
    function $11b8831ba7e63616$export$7ea66e3774a60b67(bytes) {
      return Array.from(bytes).map((b) => $11b8831ba7e63616$var$HEX_STRINGS[b >> 4] + $11b8831ba7e63616$var$HEX_STRINGS[b & 15]).join("");
    }
    function $11b8831ba7e63616$export$1a8ceedbd5845648(hex) {
      const bytes = new Uint8Array(Math.floor(hex.length / 2));
      let i;
      for (i = 0; i < bytes.length; i++) {
        const a = $11b8831ba7e63616$var$MAP_HEX[hex[i * 2]];
        const b = $11b8831ba7e63616$var$MAP_HEX[hex[i * 2 + 1]];
        if (a === void 0 || b === void 0) break;
        bytes[i] = a << 4 | b;
      }
      return i === bytes.length ? bytes : bytes.slice(0, i);
    }
    var $27314bc03f74868b$exports = {};
    $parcel$export($27314bc03f74868b$exports, "yForX", () => $27314bc03f74868b$export$c28dd39fe7cf1942);
    $parcel$export($27314bc03f74868b$exports, "scalarMultJacobian", () => $27314bc03f74868b$export$6fc8005fc3e0ffe8);
    $parcel$export($27314bc03f74868b$exports, "evalIso", () => $27314bc03f74868b$export$27808dd10edd4c0f);
    $parcel$export($27314bc03f74868b$exports, "signFq", () => $27314bc03f74868b$export$42e585c8f08aa7c5);
    $parcel$export($27314bc03f74868b$exports, "signFq2", () => $27314bc03f74868b$export$1f050984502bf9f6);
    function $27314bc03f74868b$export$c28dd39fe7cf1942(x, ec = (0, $00e9cfcde39d0b4a$export$df72980aaa0ca402)) {
      const u = x.multiply(x).multiply(x).add(ec.a.multiply(x)).add(ec.b);
      const y = u.modSqrt();
      if (y.equals(0n) || !new (0, $4508fd1f2dfd87e3$export$567266b06c239d21)(x, y, false, ec).isOnCurve()) throw new Error("No y for point x.");
      return y;
    }
    function $27314bc03f74868b$export$6fc8005fc3e0ffe8(value, point, ec = (0, $00e9cfcde39d0b4a$export$df72980aaa0ca402)) {
      if (value instanceof (0, $61122e18a0bc5a58$export$312db8bf004879ae)) value = value.value;
      let result = new (0, $f81fe8e548a259fc$export$54579cb87d860a47)(point.x.one(ec.q), point.x.one(ec.q), point.x.zero(ec.q), true, ec);
      if (point.isInfinity || (0, $013cd1e91a5ae572$export$842a2cf37af977e1)(value, ec.q) === 0n) return result;
      let addend = point;
      while (value > 0n) {
        if (value & 1n) result = result.add(addend);
        addend = addend.add(addend);
        value >>= 1n;
      }
      return result;
    }
    function $27314bc03f74868b$export$27808dd10edd4c0f(P, mapCoeffs, ec) {
      const { x, y, z } = P;
      const mapValues = [
        null,
        null,
        null,
        null
      ];
      let maxOrd = mapCoeffs[0].length;
      for (const coeffs of mapCoeffs.slice(1)) maxOrd = Math.max(maxOrd, coeffs.length);
      const zPows = [];
      for (let i = 0; i < maxOrd; i++) zPows.push(null);
      zPows[0] = z.pow(0n);
      zPows[1] = z.pow(2n);
      for (let i = 2; i < zPows.length; i++) {
        (0, $8d5e30fd5fa02b49$export$a7a9523472993e97)(zPows[i - 1] !== null);
        (0, $8d5e30fd5fa02b49$export$a7a9523472993e97)(zPows[1] !== null);
        zPows[i] = zPows[i - 1]?.multiply(zPows[1]);
      }
      for (const [i, item] of mapCoeffs.entries()) {
        const coeffsZ = item.slice().reverse().map((item2, i2) => item2.multiply(zPows[i2]));
        let temp = coeffsZ[0];
        for (const coeff of coeffsZ.slice(1)) {
          temp = temp.multiply(x);
          temp = temp.add(coeff);
        }
        mapValues[i] = temp;
      }
      (0, $8d5e30fd5fa02b49$export$a7a9523472993e97)(mapCoeffs[1].length + 1 === mapCoeffs[0].length);
      (0, $8d5e30fd5fa02b49$export$a7a9523472993e97)(zPows[1] !== null);
      (0, $8d5e30fd5fa02b49$export$a7a9523472993e97)(mapValues[1] !== null);
      mapValues[1] = mapValues[1]?.multiply(zPows[1]);
      (0, $8d5e30fd5fa02b49$export$a7a9523472993e97)(mapValues[2] !== null);
      (0, $8d5e30fd5fa02b49$export$a7a9523472993e97)(mapValues[3] !== null);
      mapValues[2] = mapValues[2].multiply(y);
      mapValues[3] = mapValues[3].multiply(z.pow(3n));
      const Z = mapValues[1].multiply(mapValues[3]);
      const X = mapValues[0].multiply(mapValues[3]).multiply(Z);
      const Y = mapValues[2].multiply(mapValues[1]).multiply(Z).multiply(Z);
      return new (0, $f81fe8e548a259fc$export$54579cb87d860a47)(X, Y, Z, P.isInfinity, ec);
    }
    function $27314bc03f74868b$export$42e585c8f08aa7c5(element, ec = (0, $00e9cfcde39d0b4a$export$df72980aaa0ca402)) {
      return element.gt(new (0, $61122e18a0bc5a58$export$312db8bf004879ae)(ec.q, (ec.q - 1n) / 2n));
    }
    function $27314bc03f74868b$export$1f050984502bf9f6(element, ec = (0, $00e9cfcde39d0b4a$export$89bff894721071da)) {
      if (element.elements[1].equals(new (0, $61122e18a0bc5a58$export$312db8bf004879ae)(ec.q, 0n))) return $27314bc03f74868b$export$42e585c8f08aa7c5(element.elements[0]);
      return element.elements[1].gt(new (0, $61122e18a0bc5a58$export$312db8bf004879ae)(ec.q, (ec.q - 1n) / 2n));
    }
    var $ee571e8a973337ec$exports = {};
    $parcel$export($ee571e8a973337ec$exports, "I2OSP", () => $ee571e8a973337ec$export$d52448d6be44c59a);
    $parcel$export($ee571e8a973337ec$exports, "OS2IP", () => $ee571e8a973337ec$export$c0271fff4884589f);
    $parcel$export($ee571e8a973337ec$exports, "bytesXor", () => $ee571e8a973337ec$export$af8f3b1836f17aeb);
    $parcel$export($ee571e8a973337ec$exports, "expandMessageXmd", () => $ee571e8a973337ec$export$ca94752eccc89d42);
    $parcel$export($ee571e8a973337ec$exports, "expandMessageXof", () => $ee571e8a973337ec$export$153ad90a5a904109);
    $parcel$export($ee571e8a973337ec$exports, "hashToField", () => $ee571e8a973337ec$export$a95bd8ce7381acba);
    $parcel$export($ee571e8a973337ec$exports, "Hp", () => $ee571e8a973337ec$export$d6b81f59cdb268dc);
    $parcel$export($ee571e8a973337ec$exports, "Hp2", () => $ee571e8a973337ec$export$55a2cd7ad104d927);
    function $ee571e8a973337ec$export$d52448d6be44c59a(value, length) {
      if (value < 0n || value >= 1n << 8n * BigInt(length)) throw new Error(`Bad I2OSP call: value=${value}, length=${length}.`);
      const bytes = [];
      for (let i = 0; i < length; i++) bytes.push(0);
      let tempValue = value;
      for (let i = length - 1; i >= 0; i--) {
        bytes[i] = Number(tempValue & 0xffn);
        tempValue >>= 8n;
      }
      const result = Uint8Array.from(bytes);
      const toBytesValue = (0, $11b8831ba7e63616$export$c0f6630717bc20c7)(value, length, "big");
      (0, $8d5e30fd5fa02b49$export$a7a9523472993e97)((0, $11b8831ba7e63616$export$c663ab80cce302c5)(result, toBytesValue));
      return result;
    }
    function $ee571e8a973337ec$export$c0271fff4884589f(octets) {
      let result = 0n;
      for (const octet of octets) {
        result <<= 8n;
        result += BigInt(octet);
      }
      (0, $8d5e30fd5fa02b49$export$a7a9523472993e97)(result === (0, $11b8831ba7e63616$export$2a52511e4f35930a)(octets, "big"));
      return result;
    }
    function $ee571e8a973337ec$export$af8f3b1836f17aeb(a, b) {
      return Uint8Array.from(a.map((element, i) => element ^ b[i]));
    }
    function $ee571e8a973337ec$export$ca94752eccc89d42(message, dst, length, hash) {
      const ell = Math.trunc((length + hash.byteSize - 1) / hash.byteSize);
      if (ell > 255) throw new Error(`Bad expandMessageXmd call: ell=${ell} out of range.`);
      const dst_prime = [
        ...dst,
        ...$ee571e8a973337ec$export$d52448d6be44c59a(BigInt(dst.length), 1)
      ];
      const Z_pad = $ee571e8a973337ec$export$d52448d6be44c59a(0n, hash.blockSize);
      const lib_str = $ee571e8a973337ec$export$d52448d6be44c59a(BigInt(length), 2);
      const b_0 = hash.convert(Uint8Array.from([
        ...Z_pad,
        ...message,
        ...lib_str,
        ...$ee571e8a973337ec$export$d52448d6be44c59a(0n, 1),
        ...dst_prime
      ]));
      const bValues = [];
      bValues.push(hash.convert(Uint8Array.from([
        ...b_0,
        ...$ee571e8a973337ec$export$d52448d6be44c59a(1n, 1),
        ...dst_prime
      ])));
      for (let i = 1; i <= ell; i++) bValues.push(hash.convert(Uint8Array.from([
        ...$ee571e8a973337ec$export$af8f3b1836f17aeb(b_0, bValues[i - 1]),
        ...$ee571e8a973337ec$export$d52448d6be44c59a(BigInt(i + 1), 1),
        ...dst_prime
      ])));
      const pseudoRandomBytes = [];
      for (const item of bValues) pseudoRandomBytes.push(...item);
      return Uint8Array.from(pseudoRandomBytes.slice(0, length));
    }
    function $ee571e8a973337ec$export$153ad90a5a904109(message, dst, length, hash) {
      const dst_prime = [
        ...dst,
        ...$ee571e8a973337ec$export$d52448d6be44c59a(BigInt(dst.length), 1)
      ];
      const message_prime = [
        ...message,
        ...$ee571e8a973337ec$export$d52448d6be44c59a(BigInt(length), 2),
        ...dst_prime
      ];
      return hash.convert(Uint8Array.from(message_prime)).slice(0, length);
    }
    function $ee571e8a973337ec$export$a95bd8ce7381acba(message, count, dst, modulus, degree, byteLength, expand, hash) {
      const lengthInBytes = count * degree * byteLength;
      const pseudoRandomBytes = expand(message, dst, lengthInBytes, hash);
      const uValues = [];
      for (let i = 0; i < count; i++) {
        const eValues = [];
        for (let j = 0; j < degree; j++) {
          const elmOffset = byteLength * (j + i * degree);
          const tv = pseudoRandomBytes.slice(elmOffset, elmOffset + byteLength);
          eValues.push((0, $013cd1e91a5ae572$export$842a2cf37af977e1)($ee571e8a973337ec$export$c0271fff4884589f(tv), modulus));
        }
        uValues.push(eValues);
      }
      return uValues;
    }
    function $ee571e8a973337ec$export$d6b81f59cdb268dc(message, count, dst) {
      return $ee571e8a973337ec$export$a95bd8ce7381acba(message, count, dst, (0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 1, 64, $ee571e8a973337ec$export$ca94752eccc89d42, (0, $1d6ac6ce37d39979$export$bced8d2aada2d1c9));
    }
    function $ee571e8a973337ec$export$55a2cd7ad104d927(message, count, dst) {
      return $ee571e8a973337ec$export$a95bd8ce7381acba(message, count, dst, (0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 2, 64, $ee571e8a973337ec$export$ca94752eccc89d42, (0, $1d6ac6ce37d39979$export$bced8d2aada2d1c9));
    }
    var $6263a241ee4922bd$exports = {};
    $parcel$export($6263a241ee4922bd$exports, "keyGen", () => $6263a241ee4922bd$export$6b169d3865731b08);
    $parcel$export($6263a241ee4922bd$exports, "ikmToLamportSk", () => $6263a241ee4922bd$export$9b45cf77d8dc3a4c);
    $parcel$export($6263a241ee4922bd$exports, "parentSkToLamportPk", () => $6263a241ee4922bd$export$fd05bc46191446d1);
    $parcel$export($6263a241ee4922bd$exports, "deriveChildSk", () => $6263a241ee4922bd$export$5db2ff97ac93f09f);
    $parcel$export($6263a241ee4922bd$exports, "deriveChildSkUnhardened", () => $6263a241ee4922bd$export$3d98d96efbfaa93e);
    $parcel$export($6263a241ee4922bd$exports, "deriveChildG1Unhardened", () => $6263a241ee4922bd$export$5c5df4dc4bd00c4c);
    $parcel$export($6263a241ee4922bd$exports, "deriveChildG2Unhardened", () => $6263a241ee4922bd$export$5bdc4123f9cc0693);
    function $6263a241ee4922bd$export$6b169d3865731b08(seed) {
      const length = 48;
      const okm = (0, $5758ad345f58e7ac$export$c0375ac2990d2f65)(length, Uint8Array.from([
        ...seed,
        0
      ]), new TextEncoder().encode("BLS-SIG-KEYGEN-SALT-"), Uint8Array.from([
        0,
        length
      ]));
      return new (0, $b7fd6731762bdca0$export$8f54525b330fd87b)((0, $013cd1e91a5ae572$export$842a2cf37af977e1)((0, $11b8831ba7e63616$export$2a52511e4f35930a)(okm, "big"), (0, $00e9cfcde39d0b4a$export$df72980aaa0ca402).n));
    }
    function $6263a241ee4922bd$export$9b45cf77d8dc3a4c(ikm, salt) {
      return (0, $5758ad345f58e7ac$export$c0375ac2990d2f65)(8160, ikm, salt, Uint8Array.from([]));
    }
    function $6263a241ee4922bd$export$fd05bc46191446d1(parentSk, index) {
      const salt = (0, $11b8831ba7e63616$export$7f883c9b3dcb5103)(index, 4, "big");
      const ikm = parentSk.toBytes();
      const notIkm = Uint8Array.from(ikm.map((e) => e ^ 255));
      const lamport0 = $6263a241ee4922bd$export$9b45cf77d8dc3a4c(ikm, salt);
      const lamport1 = $6263a241ee4922bd$export$9b45cf77d8dc3a4c(notIkm, salt);
      const lamportPk = [];
      for (let i = 0; i < 255; i++) lamportPk.push(...(0, $20b42468fafd22ce$export$699b481075cb9e0d)(lamport0.slice(i * 32, (i + 1) * 32)));
      for (let i = 0; i < 255; i++) lamportPk.push(...(0, $20b42468fafd22ce$export$699b481075cb9e0d)(lamport1.slice(i * 32, (i + 1) * 32)));
      return (0, $20b42468fafd22ce$export$699b481075cb9e0d)(Uint8Array.from(lamportPk));
    }
    function $6263a241ee4922bd$export$5db2ff97ac93f09f(parentSk, index) {
      return $6263a241ee4922bd$export$6b169d3865731b08($6263a241ee4922bd$export$fd05bc46191446d1(parentSk, index));
    }
    function $6263a241ee4922bd$export$3d98d96efbfaa93e(parentSk, index) {
      const hash = (0, $20b42468fafd22ce$export$699b481075cb9e0d)(Uint8Array.from([
        ...parentSk.getG1().toBytes(),
        ...(0, $11b8831ba7e63616$export$7f883c9b3dcb5103)(index, 4, "big")
      ]));
      return (0, $b7fd6731762bdca0$export$8f54525b330fd87b).aggregate([
        (0, $b7fd6731762bdca0$export$8f54525b330fd87b).fromBytes(hash),
        parentSk
      ]);
    }
    function $6263a241ee4922bd$export$5c5df4dc4bd00c4c(parentPk, index) {
      const hash = (0, $20b42468fafd22ce$export$699b481075cb9e0d)(Uint8Array.from([
        ...parentPk.toBytes(),
        ...(0, $11b8831ba7e63616$export$7f883c9b3dcb5103)(index, 4, "big")
      ]));
      return parentPk.add((0, $f81fe8e548a259fc$export$54579cb87d860a47).generateG1().multiply((0, $b7fd6731762bdca0$export$8f54525b330fd87b).fromBytes(hash).value));
    }
    function $6263a241ee4922bd$export$5bdc4123f9cc0693(parentPk, index) {
      const hash = (0, $20b42468fafd22ce$export$699b481075cb9e0d)(Uint8Array.from([
        ...parentPk.toBytes(),
        ...(0, $11b8831ba7e63616$export$7f883c9b3dcb5103)(index, 4, "big")
      ]));
      return parentPk.add((0, $f81fe8e548a259fc$export$54579cb87d860a47).generateG2().multiply((0, $b7fd6731762bdca0$export$8f54525b330fd87b).fromBytes(hash).value));
    }
    var $5758ad345f58e7ac$exports = {};
    $parcel$export($5758ad345f58e7ac$exports, "blockSize", () => $5758ad345f58e7ac$export$446963a0ea44fb9d);
    $parcel$export($5758ad345f58e7ac$exports, "extract", () => $5758ad345f58e7ac$export$f9380c9a627682d3);
    $parcel$export($5758ad345f58e7ac$exports, "expand", () => $5758ad345f58e7ac$export$9f77e0932fb78f72);
    $parcel$export($5758ad345f58e7ac$exports, "extractExpand", () => $5758ad345f58e7ac$export$c0375ac2990d2f65);
    var $5758ad345f58e7ac$export$446963a0ea44fb9d = 32;
    function $5758ad345f58e7ac$export$f9380c9a627682d3(salt, ikm) {
      const hash = new (0, $parcel$interopDefault($fpZC2$jssha))("SHA-256", "UINT8ARRAY", {
        hmacKey: {
          format: "UINT8ARRAY",
          value: salt
        }
      });
      hash.update(ikm);
      return hash.getHash("UINT8ARRAY");
    }
    function $5758ad345f58e7ac$export$9f77e0932fb78f72(length, prk, info) {
      const blocks = Math.ceil(length / $5758ad345f58e7ac$export$446963a0ea44fb9d);
      let bytesWritten = 0;
      const okm = [];
      let temp = Uint8Array.from([]);
      for (let i = 1; i <= blocks; i++) {
        temp = $5758ad345f58e7ac$export$f9380c9a627682d3(prk, Uint8Array.from(i === 1 ? [
          ...info,
          1
        ] : [
          ...temp,
          ...info,
          i
        ]));
        let toWrite = length - bytesWritten;
        if (toWrite > $5758ad345f58e7ac$export$446963a0ea44fb9d) toWrite = $5758ad345f58e7ac$export$446963a0ea44fb9d;
        okm.push(...temp.slice(0, toWrite));
        bytesWritten += toWrite;
      }
      (0, $8d5e30fd5fa02b49$export$a7a9523472993e97)(bytesWritten === length);
      return Uint8Array.from(okm);
    }
    function $5758ad345f58e7ac$export$c0375ac2990d2f65(length, key, salt, info) {
      return $5758ad345f58e7ac$export$9f77e0932fb78f72(length, $5758ad345f58e7ac$export$f9380c9a627682d3(salt, key), info);
    }
    var $20b42468fafd22ce$exports = {};
    $parcel$export($20b42468fafd22ce$exports, "hmacBlockSize", () => $20b42468fafd22ce$export$94a325ed6d836b5e);
    $parcel$export($20b42468fafd22ce$exports, "hash256", () => $20b42468fafd22ce$export$699b481075cb9e0d);
    $parcel$export($20b42468fafd22ce$exports, "hash512", () => $20b42468fafd22ce$export$cc147b8bd27974ac);
    $parcel$export($20b42468fafd22ce$exports, "hmac256", () => $20b42468fafd22ce$export$e10eb67e19628714);
    var $20b42468fafd22ce$export$94a325ed6d836b5e = 64;
    function $20b42468fafd22ce$export$699b481075cb9e0d(message) {
      const hash = new (0, $parcel$interopDefault($fpZC2$jssha))("SHA-256", "UINT8ARRAY");
      hash.update(message);
      return hash.getHash("UINT8ARRAY");
    }
    function $20b42468fafd22ce$export$cc147b8bd27974ac(message) {
      return Uint8Array.from([
        ...$20b42468fafd22ce$export$699b481075cb9e0d(Uint8Array.from([
          ...message,
          0
        ])),
        ...$20b42468fafd22ce$export$699b481075cb9e0d(Uint8Array.from([
          ...message,
          1
        ]))
      ]);
    }
    function $20b42468fafd22ce$export$e10eb67e19628714(message, k) {
      if (k.length > $20b42468fafd22ce$export$94a325ed6d836b5e) k = $20b42468fafd22ce$export$699b481075cb9e0d(k);
      while (k.length < $20b42468fafd22ce$export$94a325ed6d836b5e) k = Uint8Array.from([
        ...k,
        0
      ]);
      const kopad = [];
      for (let i = 0; i < $20b42468fafd22ce$export$94a325ed6d836b5e; i++) kopad.push(k[i] ^ 92);
      const kipad = [];
      for (let i = 0; i < $20b42468fafd22ce$export$94a325ed6d836b5e; i++) kipad.push(k[i] ^ 54);
      return $20b42468fafd22ce$export$699b481075cb9e0d(Uint8Array.from([
        ...kopad,
        ...$20b42468fafd22ce$export$699b481075cb9e0d(Uint8Array.from([
          ...kipad,
          ...message
        ]))
      ]));
    }
    var $013cd1e91a5ae572$exports = {};
    $parcel$export($013cd1e91a5ae572$exports, "modPow", () => $013cd1e91a5ae572$export$9747a4fa913461f);
    $parcel$export($013cd1e91a5ae572$exports, "mod", () => $013cd1e91a5ae572$export$842a2cf37af977e1);
    $parcel$export($013cd1e91a5ae572$exports, "modNumber", () => $013cd1e91a5ae572$export$64b58c5b0372ae95);
    function $013cd1e91a5ae572$export$9747a4fa913461f(base, exponent, modulo) {
      if (exponent < 1n) return 1n;
      else if (base < 0n || base > modulo) base = $013cd1e91a5ae572$export$842a2cf37af977e1(base, modulo);
      let result = 1n;
      while (exponent > 0n) {
        if ((exponent & 1n) > 0n) result = $013cd1e91a5ae572$export$842a2cf37af977e1(result * base, modulo);
        exponent >>= 1n;
        base = $013cd1e91a5ae572$export$842a2cf37af977e1(base * base, modulo);
      }
      return result;
    }
    function $013cd1e91a5ae572$export$842a2cf37af977e1(value, modulus) {
      return (value % modulus + modulus) % modulus;
    }
    function $013cd1e91a5ae572$export$64b58c5b0372ae95(value, modulus) {
      return (value % modulus + modulus) % modulus;
    }
    var $8c194b1bdb7378af$exports = {};
    $parcel$export($8c194b1bdb7378af$exports, "sgn0", () => $8c194b1bdb7378af$export$457bc114f3b6be45);
    $parcel$export($8c194b1bdb7378af$exports, "osswu2Help", () => $8c194b1bdb7378af$export$dfee9190546f1d4a);
    $parcel$export($8c194b1bdb7378af$exports, "iso3", () => $8c194b1bdb7378af$export$e784642ec1e5cf56);
    $parcel$export($8c194b1bdb7378af$exports, "optSwu2Map", () => $8c194b1bdb7378af$export$ee5c28ad16e024d8);
    $parcel$export($8c194b1bdb7378af$exports, "g2Map", () => $8c194b1bdb7378af$export$74473883de6345ad);
    function $8c194b1bdb7378af$export$457bc114f3b6be45(x) {
      const sign0 = (0, $013cd1e91a5ae572$export$842a2cf37af977e1)(x.elements[0].value, 2n) === 1n;
      const zero0 = x.elements[0].value === 0n;
      const sign1 = (0, $013cd1e91a5ae572$export$842a2cf37af977e1)(x.elements[1].value, 2n) === 1n;
      return sign0 || zero0 && sign1 ? 1n : 0n;
    }
    function $8c194b1bdb7378af$export$dfee9190546f1d4a(t) {
      const numDenCommon = (0, $7114a315a435248d$export$8d1968de8a0388cb).pow(2n).multiply(t.pow(4n)).add((0, $7114a315a435248d$export$8d1968de8a0388cb).multiply(t.pow(2n)));
      const x0_num = (0, $7114a315a435248d$export$a49b3bf2a8f9ece3).multiply(numDenCommon.add(new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), 1n)));
      let x0_den = (0, $7114a315a435248d$export$cb23cd3dd580e72c).negate().multiply(numDenCommon);
      x0_den = x0_den.equals(0n) ? (0, $7114a315a435248d$export$cb23cd3dd580e72c).multiply((0, $7114a315a435248d$export$8d1968de8a0388cb)) : x0_den;
      const gx0_den = x0_den.pow(3n);
      const gx0_num = (0, $7114a315a435248d$export$a49b3bf2a8f9ece3).multiply(gx0_den).add((0, $7114a315a435248d$export$cb23cd3dd580e72c).multiply(x0_num).multiply(x0_den.pow(2n))).add(x0_num.pow(3n));
      let temp1 = gx0_den.pow(7n);
      const temp2 = gx0_num.multiply(temp1);
      temp1 = temp1.multiply(temp2).multiply(gx0_den);
      let sqrtCandidate = temp2.multiply(temp1.pow(((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162) ** 2n - 9n) / 16n));
      for (const root of (0, $45c5a0c79e0736cc$export$5e60bb11dae8e64b)) {
        let y0 = sqrtCandidate.multiply(root);
        if (y0.pow(2n).multiply(gx0_den).equals(gx0_num)) {
          if ($8c194b1bdb7378af$export$457bc114f3b6be45(y0) !== $8c194b1bdb7378af$export$457bc114f3b6be45(t)) y0 = y0.negate();
          (0, $8d5e30fd5fa02b49$export$a7a9523472993e97)($8c194b1bdb7378af$export$457bc114f3b6be45(y0) === $8c194b1bdb7378af$export$457bc114f3b6be45(t));
          return new (0, $f81fe8e548a259fc$export$54579cb87d860a47)(x0_num.multiply(x0_den), y0.multiply(x0_den.pow(3n)), x0_den, false, (0, $00e9cfcde39d0b4a$export$89bff894721071da));
        }
      }
      const x1_num = (0, $7114a315a435248d$export$8d1968de8a0388cb).multiply(t.pow(2n)).multiply(x0_num);
      const x1_den = x0_den;
      const gx1_num = (0, $7114a315a435248d$export$8d1968de8a0388cb).pow(3n).multiply(t.pow(6n)).multiply(gx0_num);
      const gx1_den = gx0_den;
      sqrtCandidate = sqrtCandidate.multiply(t.pow(3n));
      for (const eta of (0, $7114a315a435248d$export$dfed87f2d11110f4)) {
        let y1 = eta.multiply(sqrtCandidate);
        if (y1.pow(2n).multiply(gx1_den).equals(gx1_num)) {
          if ($8c194b1bdb7378af$export$457bc114f3b6be45(y1) !== $8c194b1bdb7378af$export$457bc114f3b6be45(t)) y1 = y1.negate();
          (0, $8d5e30fd5fa02b49$export$a7a9523472993e97)($8c194b1bdb7378af$export$457bc114f3b6be45(y1) === $8c194b1bdb7378af$export$457bc114f3b6be45(t));
          return new (0, $f81fe8e548a259fc$export$54579cb87d860a47)(x1_num.multiply(x1_den), y1.multiply(x1_den.pow(3n)), x1_den, false, (0, $00e9cfcde39d0b4a$export$89bff894721071da));
        }
      }
      throw new Error("Bad osswu2Help.");
    }
    function $8c194b1bdb7378af$export$e784642ec1e5cf56(P) {
      return (0, $27314bc03f74868b$export$27808dd10edd4c0f)(P, [
        (0, $8856e63c79a7a18e$export$4c6c1dafe316d2c),
        (0, $8856e63c79a7a18e$export$732ae2b2551ff413),
        (0, $8856e63c79a7a18e$export$ea2765eb3fc09cbc),
        (0, $8856e63c79a7a18e$export$54826405639b5799)
      ], (0, $00e9cfcde39d0b4a$export$89bff894721071da));
    }
    function $8c194b1bdb7378af$export$ee5c28ad16e024d8(t, t2) {
      let Pp = $8c194b1bdb7378af$export$e784642ec1e5cf56($8c194b1bdb7378af$export$dfee9190546f1d4a(t));
      if (t2) {
        const Pp2 = $8c194b1bdb7378af$export$e784642ec1e5cf56($8c194b1bdb7378af$export$dfee9190546f1d4a(t2));
        Pp = Pp.add(Pp2);
      }
      return Pp.multiply((0, $00e9cfcde39d0b4a$export$41b7b4fef7f76fa9));
    }
    function $8c194b1bdb7378af$export$74473883de6345ad(alpha, dst) {
      const elements = (0, $ee571e8a973337ec$export$55a2cd7ad104d927)(alpha, 2, dst).map((hh) => {
        const items = hh.map((value) => new (0, $61122e18a0bc5a58$export$312db8bf004879ae)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), value));
        return new (0, $ee4c81c840b9d78d$export$3250f1bd1b840331)((0, $00e9cfcde39d0b4a$export$9e5f44173e64f162), items[0], items[1]);
      });
      return $8c194b1bdb7378af$export$ee5c28ad16e024d8(elements[0], elements[1]);
    }
    var $18de921ac0e3bf52$exports = {};
    $parcel$export($18de921ac0e3bf52$exports, "doubleLineEval", () => $18de921ac0e3bf52$export$c11f3970c3ad259);
    $parcel$export($18de921ac0e3bf52$exports, "addLineEval", () => $18de921ac0e3bf52$export$bd894c1853ea7ce9);
    $parcel$export($18de921ac0e3bf52$exports, "millerLoop", () => $18de921ac0e3bf52$export$d2495f48e21d1b97);
    $parcel$export($18de921ac0e3bf52$exports, "finalExponentiation", () => $18de921ac0e3bf52$export$d2180c627b521e81);
    $parcel$export($18de921ac0e3bf52$exports, "atePairing", () => $18de921ac0e3bf52$export$740729f8e739fd84);
    $parcel$export($18de921ac0e3bf52$exports, "atePairingMulti", () => $18de921ac0e3bf52$export$18b00e9902a9edab);
    function $18de921ac0e3bf52$export$c11f3970c3ad259(R, P, ec = (0, $00e9cfcde39d0b4a$export$df72980aaa0ca402)) {
      const R12 = R.untwist();
      const slope = new (0, $61122e18a0bc5a58$export$312db8bf004879ae)(ec.q, 3n).multiply(R12.x.pow(2n).add(ec.a)).divide(R12.y.multiply(new (0, $61122e18a0bc5a58$export$312db8bf004879ae)(ec.q, 2n)));
      const v = R12.y.subtract(R12.x.multiply(slope));
      return P.y.subtract(P.x.multiply(slope)).subtract(v);
    }
    function $18de921ac0e3bf52$export$bd894c1853ea7ce9(R, Q, P) {
      const R12 = R.untwist();
      const Q12 = Q.untwist();
      if (R12.equals(Q12.negate())) return P.x.subtract(R12.x);
      const slope = Q12.y.subtract(R12.y).divide(Q12.x.subtract(R12.x));
      const v = Q12.y.multiply(R12.x).subtract(R12.y.multiply(Q12.x)).divide(R12.x.subtract(Q12.x));
      return P.y.subtract(P.x.multiply(slope)).subtract(v);
    }
    function $18de921ac0e3bf52$export$d2495f48e21d1b97(T, P, Q, ec = (0, $00e9cfcde39d0b4a$export$df72980aaa0ca402)) {
      const T_bits = (0, $11b8831ba7e63616$export$59537329b9c511e9)(T);
      let R = Q;
      let f = (0, $e01fe8766586be5e$export$d12e5c25403eca16).nil.one(ec.q);
      for (let i = 1; i < T_bits.length; i++) {
        const lrr = $18de921ac0e3bf52$export$c11f3970c3ad259(R, P, ec);
        f = f.multiply(f).multiply(lrr);
        R = R.multiply(new (0, $61122e18a0bc5a58$export$312db8bf004879ae)(ec.q, 2n));
        if (T_bits[i] === 1) {
          const lrq = $18de921ac0e3bf52$export$bd894c1853ea7ce9(R, Q, P);
          f = f.multiply(lrq);
          R = R.add(Q);
        }
      }
      return f;
    }
    function $18de921ac0e3bf52$export$d2180c627b521e81(element, ec = (0, $00e9cfcde39d0b4a$export$df72980aaa0ca402)) {
      if (ec.k === 12n) {
        let ans = element.pow((ec.q ** 4n - ec.q ** 2n + 1n) / ec.n);
        ans = ans.qiPower(2).multiply(ans);
        ans = ans.qiPower(6).divide(ans);
        return ans;
      } else return element.pow((ec.q ** ec.k - 1n) / ec.n);
    }
    function $18de921ac0e3bf52$export$740729f8e739fd84(P, Q, ec = (0, $00e9cfcde39d0b4a$export$df72980aaa0ca402)) {
      const t = (0, $00e9cfcde39d0b4a$export$df72980aaa0ca402).x + 1n;
      let T = t - 1n;
      T = T < 0n ? -T : T;
      return $18de921ac0e3bf52$export$d2180c627b521e81($18de921ac0e3bf52$export$d2495f48e21d1b97(T, P.toAffine(), Q.toAffine()), ec);
    }
    function $18de921ac0e3bf52$export$18b00e9902a9edab(Ps, Qs, ec = (0, $00e9cfcde39d0b4a$export$df72980aaa0ca402)) {
      const t = (0, $00e9cfcde39d0b4a$export$df72980aaa0ca402).x + 1n;
      let T = t - 1n;
      T = T < 0n ? -T : T;
      let prod = (0, $e01fe8766586be5e$export$d12e5c25403eca16).nil.one(ec.q);
      for (let i = 0; i < Qs.length; i++) prod = prod.multiply($18de921ac0e3bf52$export$d2495f48e21d1b97(T, Ps[i].toAffine(), Qs[i].toAffine(), ec));
      return $18de921ac0e3bf52$export$d2180c627b521e81(prod, ec);
    }
    var $e66c6c730aa32243$exports = {};
    $parcel$export($e66c6c730aa32243$exports, "coreSignMpl", () => $e66c6c730aa32243$export$d36c55300691c9bd);
    $parcel$export($e66c6c730aa32243$exports, "coreVerifyMpl", () => $e66c6c730aa32243$export$fa86e59803ac4685);
    $parcel$export($e66c6c730aa32243$exports, "coreAggregateMpl", () => $e66c6c730aa32243$export$58639efa77ac2d9c);
    $parcel$export($e66c6c730aa32243$exports, "coreAggregateVerify", () => $e66c6c730aa32243$export$6d85de9d133db9bf);
    function $e66c6c730aa32243$export$d36c55300691c9bd(sk, message, dst) {
      return (0, $8c194b1bdb7378af$export$74473883de6345ad)(message, dst).multiply(sk.value);
    }
    function $e66c6c730aa32243$export$fa86e59803ac4685(pk, message, signature, dst) {
      if (!signature.isValid() || !pk.isValid()) return false;
      const q = (0, $8c194b1bdb7378af$export$74473883de6345ad)(message, dst);
      const one = (0, $e01fe8766586be5e$export$d12e5c25403eca16).nil.one((0, $00e9cfcde39d0b4a$export$df72980aaa0ca402).q);
      const pairingResult = (0, $18de921ac0e3bf52$export$18b00e9902a9edab)([
        pk,
        (0, $f81fe8e548a259fc$export$54579cb87d860a47).generateG1().negate()
      ], [
        q,
        signature
      ]);
      return pairingResult.equals(one);
    }
    function $e66c6c730aa32243$export$58639efa77ac2d9c(signatures) {
      if (!signatures.length) throw new Error("Must aggregate at least 1 signature.");
      let aggregate = signatures[0];
      (0, $8d5e30fd5fa02b49$export$a7a9523472993e97)(aggregate.isValid());
      for (const signature of signatures.slice(1)) {
        (0, $8d5e30fd5fa02b49$export$a7a9523472993e97)(signature.isValid());
        aggregate = aggregate.add(signature);
      }
      return aggregate;
    }
    function $e66c6c730aa32243$export$6d85de9d133db9bf(pks, ms, signature, dst) {
      if (pks.length !== ms.length || !pks.length) return false;
      if (!signature.isValid()) return false;
      const qs = [
        signature
      ];
      const ps = [
        (0, $f81fe8e548a259fc$export$54579cb87d860a47).generateG1().negate()
      ];
      for (let i = 0; i < pks.length; i++) {
        if (!pks[i].isValid()) return false;
        qs.push((0, $8c194b1bdb7378af$export$74473883de6345ad)(ms[i], dst));
        ps.push(pks[i]);
      }
      return (0, $e01fe8766586be5e$export$d12e5c25403eca16).nil.one((0, $00e9cfcde39d0b4a$export$df72980aaa0ca402).q).equals((0, $18de921ac0e3bf52$export$18b00e9902a9edab)(ps, qs));
    }
    $parcel$exportWildcard($dedcfd393dea00ca$exports, $6c617017d170275f$exports);
    $parcel$exportWildcard($dedcfd393dea00ca$exports, $dde8a229c2cb8a5c$exports);
    $parcel$exportWildcard($dedcfd393dea00ca$exports, $61122e18a0bc5a58$exports);
    $parcel$exportWildcard($dedcfd393dea00ca$exports, $ee4c81c840b9d78d$exports);
    $parcel$exportWildcard($dedcfd393dea00ca$exports, $f9eca204c73b879f$exports);
    $parcel$exportWildcard($dedcfd393dea00ca$exports, $e01fe8766586be5e$exports);
    $parcel$exportWildcard($dedcfd393dea00ca$exports, $00e9cfcde39d0b4a$exports);
    $parcel$exportWildcard($dedcfd393dea00ca$exports, $3dc2627f1a74b978$exports);
    $parcel$exportWildcard($dedcfd393dea00ca$exports, $1d6ac6ce37d39979$exports);
    $parcel$exportWildcard($dedcfd393dea00ca$exports, $8856e63c79a7a18e$exports);
    $parcel$exportWildcard($dedcfd393dea00ca$exports, $7114a315a435248d$exports);
    $parcel$exportWildcard($dedcfd393dea00ca$exports, $45c5a0c79e0736cc$exports);
    $parcel$exportWildcard($dedcfd393dea00ca$exports, $5f5e7634db6ec17d$exports);
    $parcel$exportWildcard($dedcfd393dea00ca$exports, $4508fd1f2dfd87e3$exports);
    $parcel$exportWildcard($dedcfd393dea00ca$exports, $6855b0e4fef0dbbe$exports);
    $parcel$exportWildcard($dedcfd393dea00ca$exports, $f81fe8e548a259fc$exports);
    $parcel$exportWildcard($dedcfd393dea00ca$exports, $652b9d23a743e8c2$exports);
    $parcel$exportWildcard($dedcfd393dea00ca$exports, $8d5e30fd5fa02b49$exports);
    $parcel$exportWildcard($dedcfd393dea00ca$exports, $d8b9abe285040e16$exports);
    $parcel$exportWildcard($dedcfd393dea00ca$exports, $b7fd6731762bdca0$exports);
    $parcel$exportWildcard($dedcfd393dea00ca$exports, $46e980308398850e$exports);
    $parcel$exportWildcard($dedcfd393dea00ca$exports, $cbd8901008cf0b7e$exports);
    $parcel$exportWildcard($dedcfd393dea00ca$exports, $c20e836927ce4374$exports);
    $parcel$exportWildcard($dedcfd393dea00ca$exports, $11b8831ba7e63616$exports);
    $parcel$exportWildcard($dedcfd393dea00ca$exports, $27314bc03f74868b$exports);
    $parcel$exportWildcard($dedcfd393dea00ca$exports, $ee571e8a973337ec$exports);
    $parcel$exportWildcard($dedcfd393dea00ca$exports, $6263a241ee4922bd$exports);
    $parcel$exportWildcard($dedcfd393dea00ca$exports, $5758ad345f58e7ac$exports);
    $parcel$exportWildcard($dedcfd393dea00ca$exports, $20b42468fafd22ce$exports);
    $parcel$exportWildcard($dedcfd393dea00ca$exports, $013cd1e91a5ae572$exports);
    $parcel$exportWildcard($dedcfd393dea00ca$exports, $8c194b1bdb7378af$exports);
    $parcel$exportWildcard($dedcfd393dea00ca$exports, $18de921ac0e3bf52$exports);
    $parcel$exportWildcard($dedcfd393dea00ca$exports, $e66c6c730aa32243$exports);
    $parcel$exportWildcard(module.exports, $dedcfd393dea00ca$exports);
  }
});

// ../node_modules/.pnpm/clvm-lib@1.0.1/node_modules/clvm-lib/dist/src/index.js
var require_src2 = __commonJS({
  "../node_modules/.pnpm/clvm-lib@1.0.1/node_modules/clvm-lib/dist/src/index.js"(exports, module) {
    var $fpZC2$chiabls = require_src();
    function $parcel$exportWildcard(dest, source) {
      Object.keys(source).forEach(function(key) {
        if (key === "default" || key === "__esModule" || Object.prototype.hasOwnProperty.call(dest, key)) {
          return;
        }
        Object.defineProperty(dest, key, {
          enumerable: true,
          get: function get() {
            return source[key];
          }
        });
      });
      return dest;
    }
    function $parcel$export(e, n, v, s) {
      Object.defineProperty(e, n, { get: v, set: s, enumerable: true, configurable: true });
    }
    $parcel$export(module.exports, "Program", () => $9636c8954d640602$export$b6c59b989905b650);
    var $a550084cece3e4e0$exports = {};
    $parcel$export($a550084cece3e4e0$exports, "ParserError", () => $a550084cece3e4e0$export$d125cf0331bff9a9);
    var $a550084cece3e4e0$export$d125cf0331bff9a9 = class _$a550084cece3e4e0$export$d125cf0331bff9a9 extends Error {
      constructor(message) {
        super(message);
        Object.setPrototypeOf(this, _$a550084cece3e4e0$export$d125cf0331bff9a9.prototype);
      }
    };
    var $94ca46fd7d128ba2$export$eebaaf2b24d91f63 = {
      q: 0x01n,
      a: 0x02n,
      i: 0x03n,
      c: 0x04n,
      f: 0x05n,
      r: 0x06n,
      l: 0x07n,
      x: 0x08n,
      "=": 0x09n,
      ">s": 0x0an,
      sha256: 0x0bn,
      substr: 0x0cn,
      strlen: 0x0dn,
      concat: 0x0en,
      "+": 0x10n,
      "-": 0x11n,
      "*": 0x12n,
      "/": 0x13n,
      divmod: 0x14n,
      ">": 0x15n,
      ash: 0x16n,
      lsh: 0x17n,
      logand: 0x18n,
      logior: 0x19n,
      logxor: 0x1an,
      lognot: 0x1bn,
      point_add: 0x1dn,
      pubkey_for_exp: 0x1en,
      not: 0x20n,
      any: 0x21n,
      all: 0x22n,
      ".": 0x23n,
      softfork: 0x24n
    };
    var $1382d0708deed0de$export$b81a09a7187d4786 = `0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!"#$%&'()*+,-./:;<=>?@[]^_\`{|}~ 	

\v\f`;
    var $69b3f00f8a7733d7$export$2ede34752a982e57 = (0, $fpZC2$chiabls.encodeBigInt)((0, $94ca46fd7d128ba2$export$eebaaf2b24d91f63)["q"]);
    var $69b3f00f8a7733d7$export$688e2fe60354a4fd = (0, $fpZC2$chiabls.encodeBigInt)((0, $94ca46fd7d128ba2$export$eebaaf2b24d91f63)["a"]);
    var $69b3f00f8a7733d7$export$15235ce324d8441e = (0, $fpZC2$chiabls.encodeBigInt)((0, $94ca46fd7d128ba2$export$eebaaf2b24d91f63)["f"]);
    var $69b3f00f8a7733d7$export$11418da7d6f16373 = (0, $fpZC2$chiabls.encodeBigInt)((0, $94ca46fd7d128ba2$export$eebaaf2b24d91f63)["r"]);
    var $69b3f00f8a7733d7$export$2542912e97e68f4e = (0, $fpZC2$chiabls.encodeBigInt)((0, $94ca46fd7d128ba2$export$eebaaf2b24d91f63)["c"]);
    var $69b3f00f8a7733d7$export$9d2b043fe7614ba5 = (0, $fpZC2$chiabls.encodeBigInt)((0, $94ca46fd7d128ba2$export$eebaaf2b24d91f63)["x"]);
    var $17c1ef024405b6ea$export$a4dd1bf5a8aa5573 = class _$17c1ef024405b6ea$export$a4dd1bf5a8aa5573 extends Set {
      isSuperset(set) {
        for (const item of set) if (!this.has(item)) return false;
        return true;
      }
      isSubset(set) {
        for (const item of this) if (!set.has(item)) return false;
        return true;
      }
      isSupersetProper(set) {
        return this.isSuperset(set) && !this.isSubset(set);
      }
      isSubsetProper(set) {
        return this.isSubset(set) && !this.isSuperset(set);
      }
      equals(set) {
        return this.isSubset(set) && this.isSuperset(set);
      }
      union(set) {
        const union = new _$17c1ef024405b6ea$export$a4dd1bf5a8aa5573(this);
        for (const item of set) union.add(item);
        return union;
      }
      intersection(set) {
        const intersection = new _$17c1ef024405b6ea$export$a4dd1bf5a8aa5573();
        for (const item of set) if (this.has(item)) intersection.add(item);
        return intersection;
      }
      symmetricDifference(set) {
        const difference = new _$17c1ef024405b6ea$export$a4dd1bf5a8aa5573(this);
        for (const item of set) if (difference.has(item)) difference.delete(item);
        else difference.add(item);
        return difference;
      }
      difference(set) {
        const difference = new _$17c1ef024405b6ea$export$a4dd1bf5a8aa5573(this);
        for (const item of set) difference.delete(item);
        return difference;
      }
      update(set) {
        for (const item of set) this.add(item);
        return this;
      }
      differenceUpdate(set) {
        for (const item of set) this.delete(item);
        return this;
      }
      symmetricDifferenceUpdate(set) {
        for (const item of set) if (this.has(item)) this.delete(item);
        else this.add(item);
        return this;
      }
      intersectionUpdate(set) {
        for (const item of this) if (!set.has(item)) this.delete(item);
        return this;
      }
      sort(sorter) {
        return new _$17c1ef024405b6ea$export$a4dd1bf5a8aa5573([
          ...this
        ].sort(sorter));
      }
      map(mapper) {
        const result = new _$17c1ef024405b6ea$export$a4dd1bf5a8aa5573();
        let index = 0;
        for (const item of this) result.add(mapper(item, index++, this));
        return result;
      }
      filter(predicate) {
        const result = new _$17c1ef024405b6ea$export$a4dd1bf5a8aa5573();
        let index = 0;
        for (const item of this) if (predicate(item, index++, this)) result.add(item);
        return result;
      }
    };
    function $3f2125465f2f6884$export$7ac16079f594c861(left, right) {
      let mask = 1n;
      let tempPath = left;
      while (tempPath > 1n) {
        right <<= 1n;
        mask <<= 1n;
        tempPath >>= 1n;
      }
      mask -= 1n;
      return right | left & mask;
    }
    var $3f2125465f2f6884$export$119c224dc5fdfaa6 = class _$3f2125465f2f6884$export$119c224dc5fdfaa6 {
      static top = new _$3f2125465f2f6884$export$119c224dc5fdfaa6();
      static left = _$3f2125465f2f6884$export$119c224dc5fdfaa6.top.first();
      static right = _$3f2125465f2f6884$export$119c224dc5fdfaa6.top.rest();
      index;
      constructor(index = 1n) {
        if (index < 0n) {
          const byteCount = (0, $fpZC2$chiabls.bigIntBitLength)(index) + 7 >> 3;
          const blob = (0, $fpZC2$chiabls.bigIntToBytes)(index, byteCount, "big", true);
          index = (0, $fpZC2$chiabls.bytesToBigInt)(Uint8Array.from([
            0,
            ...blob
          ]), "big", false);
        }
        this.index = index;
      }
      asPath() {
        const byteCount = (0, $fpZC2$chiabls.bigIntBitLength)(this.index) + 7 >> 3;
        return (0, $fpZC2$chiabls.bigIntToBytes)(this.index, byteCount, "big");
      }
      add(other) {
        return new _$3f2125465f2f6884$export$119c224dc5fdfaa6($3f2125465f2f6884$export$7ac16079f594c861(this.index, other.index));
      }
      first() {
        return new _$3f2125465f2f6884$export$119c224dc5fdfaa6(this.index * 2n);
      }
      rest() {
        return new _$3f2125465f2f6884$export$119c224dc5fdfaa6(this.index * 2n + 1n);
      }
      toString() {
        return `NodePath: ${this.index}`;
      }
    };
    function $ec4be0719743fcdf$export$15d71aa2e69a0c29(program) {
      return (0, $9636c8954d640602$export$b6c59b989905b650).cons((0, $9636c8954d640602$export$b6c59b989905b650).fromBigInt((0, $94ca46fd7d128ba2$export$eebaaf2b24d91f63)["q"]), program);
    }
    function $ec4be0719743fcdf$export$57e68749c88bb462(program, args) {
      return (0, $9636c8954d640602$export$b6c59b989905b650).fromList([
        (0, $9636c8954d640602$export$b6c59b989905b650).fromBigInt((0, $94ca46fd7d128ba2$export$eebaaf2b24d91f63)["a"]),
        program,
        args
      ]);
    }
    function $ec4be0719743fcdf$export$9692bc1ad98955fc(program, args) {
      return $ec4be0719743fcdf$export$57e68749c88bb462($ec4be0719743fcdf$export$15d71aa2e69a0c29(program), $ec4be0719743fcdf$export$15d71aa2e69a0c29(args));
    }
    var $c1f25f83b21fbca5$var$defaultMacroSources = [
      `
    ; we have to compile this externally, since it uses itself
    ;(defmacro defmacro (name params body)
    ;    (qq (list (unquote name) (mod (unquote params) (unquote body))))
    ;)
    (q . ("defmacro"
       (c (q . "list")
          (c (f 1)
             (c (c (q . "mod")
                   (c (f (r 1))
                      (c (f (r (r 1)))
                         (q . ()))))
                (q . ()))))))
    `,
      `
    ;(defmacro list ARGS
    ;    ((c (mod args
    ;        (defun compile-list
    ;               (args)
    ;               (if args
    ;                   (qq (c (unquote (f args))
    ;                         (unquote (compile-list (r args)))))
    ;                   ()))
    ;            (compile-list args)
    ;        )
    ;        ARGS
    ;    ))
    ;)
    (q "list"
        (a (q #a (q #a 2 (c 2 (c 3 (q))))
                 (c (q #a (i 5
                             (q #c (q . 4)
                                   (c 9 (c (a 2 (c 2 (c 13 (q))))
                                           (q)))
                             )
                             (q 1))
                           1)
                    1))
            1))
    `,
      `(defmacro function (BODY)
        (qq (opt (com (q . (unquote BODY))
                 (qq (unquote (macros)))
                 (qq (unquote (symbols)))))))`,
      `(defmacro if (A B C)
        (qq (a
            (i (unquote A)
               (function (unquote B))
               (function (unquote C)))
            @)))`,
      `(defmacro / (A B) (qq (f (divmod (unquote A) (unquote B)))))`
    ];
    var $c1f25f83b21fbca5$var$defaultMacroLookupProgram;
    function $c1f25f83b21fbca5$var$buildDefaultMacroLookup(evalAsProgram) {
      const run = (0, $9636c8954d640602$export$b6c59b989905b650).fromSource("(a (com 2 3) 1)");
      for (const macroSource of $c1f25f83b21fbca5$var$defaultMacroSources) {
        const macroProgram = (0, $9636c8954d640602$export$b6c59b989905b650).fromSource(macroSource);
        const env = (0, $9636c8954d640602$export$b6c59b989905b650).cons(macroProgram, $c1f25f83b21fbca5$var$defaultMacroLookupProgram);
        const newMacro = evalAsProgram(run, env).value;
        $c1f25f83b21fbca5$var$defaultMacroLookupProgram = (0, $9636c8954d640602$export$b6c59b989905b650).cons(newMacro, $c1f25f83b21fbca5$var$defaultMacroLookupProgram);
      }
      return $c1f25f83b21fbca5$var$defaultMacroLookupProgram;
    }
    function $c1f25f83b21fbca5$export$35ac38cd538ce3a4(evalAsProgram) {
      if (!$c1f25f83b21fbca5$var$defaultMacroLookupProgram || $c1f25f83b21fbca5$var$defaultMacroLookupProgram.isNull) {
        $c1f25f83b21fbca5$var$defaultMacroLookupProgram = (0, $9636c8954d640602$export$b6c59b989905b650).fromList([]);
        $c1f25f83b21fbca5$var$buildDefaultMacroLookup(evalAsProgram);
      }
      return $c1f25f83b21fbca5$var$defaultMacroLookupProgram;
    }
    function $b8dc7cb54aa9eaa3$export$633da1651c3bd3f9(a, b) {
      return a < b ? -1 : a > b ? 1 : 0;
    }
    var $b28f999d37dccebe$var$atomMatch = new TextEncoder().encode("$");
    var $b28f999d37dccebe$var$sexpMatch = new TextEncoder().encode(":");
    function $b28f999d37dccebe$export$c85aa06d1e6a7731(bindings, key, valueProgram) {
      if (key in bindings) {
        if (!bindings[key].equals(valueProgram)) return null;
        return bindings;
      }
      return {
        ...bindings,
        [key]: valueProgram
      };
    }
    function $b28f999d37dccebe$export$4659b591c19bdf3d(pattern, sexp, knownBindings = {}) {
      if (!pattern.isCons) {
        if (sexp.isCons) return null;
        return (0, $fpZC2$chiabls.bytesEqual)(pattern.atom, sexp.atom) ? knownBindings : null;
      }
      const left = pattern.first;
      const right = pattern.rest;
      if (left.isAtom && (0, $fpZC2$chiabls.bytesEqual)(left.atom, $b28f999d37dccebe$var$atomMatch)) {
        if (sexp.isCons) return null;
        if (right.isAtom && (0, $fpZC2$chiabls.bytesEqual)(right.atom, $b28f999d37dccebe$var$atomMatch)) {
          if ((0, $fpZC2$chiabls.bytesEqual)(sexp.atom, $b28f999d37dccebe$var$atomMatch)) return {};
          return null;
        }
        return $b28f999d37dccebe$export$c85aa06d1e6a7731(knownBindings, right.toText(), sexp);
      }
      if (left.isAtom && (0, $fpZC2$chiabls.bytesEqual)(left.atom, $b28f999d37dccebe$var$sexpMatch)) {
        if (right.isAtom && (0, $fpZC2$chiabls.bytesEqual)(right.atom, $b28f999d37dccebe$var$sexpMatch)) {
          if ((0, $fpZC2$chiabls.bytesEqual)(sexp.atom, $b28f999d37dccebe$var$sexpMatch)) return {};
          return null;
        }
        return $b28f999d37dccebe$export$c85aa06d1e6a7731(knownBindings, right.toText(), sexp);
      }
      if (!sexp.isCons) return null;
      const newBindings = $b28f999d37dccebe$export$4659b591c19bdf3d(left, sexp.first, knownBindings);
      if (!newBindings) return newBindings;
      return $b28f999d37dccebe$export$4659b591c19bdf3d(right, sexp.rest, newBindings);
    }
    function $a985f73a592474fb$export$6eee28b7ff726723(program) {
      if (!program.isCons) return program.isNull;
      const operator = program.first;
      if (!operator.isCons) {
        const value = operator.atom;
        if ((0, $fpZC2$chiabls.bytesEqual)(value, (0, $69b3f00f8a7733d7$export$2ede34752a982e57))) return true;
        else if ((0, $fpZC2$chiabls.bytesEqual)(value, (0, $69b3f00f8a7733d7$export$9d2b043fe7614ba5))) return false;
      } else if (!$a985f73a592474fb$export$6eee28b7ff726723(operator)) return false;
      return program.rest.toList().every((item) => $a985f73a592474fb$export$6eee28b7ff726723(item));
    }
    function $a985f73a592474fb$export$4b7046275197ae1c(program, evalAsProgram) {
      if ($a985f73a592474fb$export$6eee28b7ff726723(program) && !program.isNull) {
        const newProgram = evalAsProgram(program, (0, $9636c8954d640602$export$b6c59b989905b650).nil).value;
        program = (0, $ec4be0719743fcdf$export$15d71aa2e69a0c29)(newProgram);
      }
      return program;
    }
    function $a985f73a592474fb$export$3ee5814c52647d49(program) {
      return program.isAtom && program.toBigInt() === 1n;
    }
    function $a985f73a592474fb$export$6e8a6ed2471a063e(program, _evalAsProgram) {
      const matched = (0, $b28f999d37dccebe$export$4659b591c19bdf3d)((0, $9636c8954d640602$export$b6c59b989905b650).fromSource("(a (q . (: . sexp)) (: . args))"), program);
      if (matched && $a985f73a592474fb$export$3ee5814c52647d49(matched["args"])) return matched["sexp"];
      return program;
    }
    function $a985f73a592474fb$export$840131dd5ee64358(args) {
      const matched = (0, $b28f999d37dccebe$export$4659b591c19bdf3d)((0, $9636c8954d640602$export$b6c59b989905b650).fromSource("(c (: . first) (: . rest))"), args);
      if (matched) return matched["first"];
      return (0, $9636c8954d640602$export$b6c59b989905b650).fromList([
        (0, $9636c8954d640602$export$b6c59b989905b650).fromBigInt((0, $94ca46fd7d128ba2$export$eebaaf2b24d91f63)["f"]),
        args
      ]);
    }
    function $a985f73a592474fb$export$a540b74c4a2a7577(args) {
      const matched = (0, $b28f999d37dccebe$export$4659b591c19bdf3d)((0, $9636c8954d640602$export$b6c59b989905b650).fromSource("(c (: . first) (: . rest))"), args);
      if (matched) return matched["rest"];
      return (0, $9636c8954d640602$export$b6c59b989905b650).fromList([
        (0, $9636c8954d640602$export$b6c59b989905b650).fromBigInt((0, $94ca46fd7d128ba2$export$eebaaf2b24d91f63)["r"]),
        args
      ]);
    }
    function $a985f73a592474fb$export$c5d611a83338c57a(program, args) {
      const value = program.toBigInt();
      if (value <= 1n) return args;
      program = (0, $9636c8954d640602$export$b6c59b989905b650).fromBigInt(value >> 1n);
      if (value & 1n) return $a985f73a592474fb$export$c5d611a83338c57a(program, $a985f73a592474fb$export$a540b74c4a2a7577(args));
      return $a985f73a592474fb$export$c5d611a83338c57a(program, $a985f73a592474fb$export$840131dd5ee64358(args));
    }
    function $a985f73a592474fb$export$f44402eed32c89db(program, args) {
      if (!program.isCons) return $a985f73a592474fb$export$c5d611a83338c57a(program, args);
      let first = program.first;
      if (first.isCons) first = $a985f73a592474fb$export$f44402eed32c89db(first, args);
      else if ((0, $fpZC2$chiabls.bytesEqual)(first.atom, (0, $69b3f00f8a7733d7$export$2ede34752a982e57))) return program;
      return (0, $9636c8954d640602$export$b6c59b989905b650).fromList([
        first,
        ...program.rest.toList().map((item) => $a985f73a592474fb$export$f44402eed32c89db(item, args))
      ]);
    }
    function $a985f73a592474fb$export$47ba71260b7e33dc(program, evalAsProgram) {
      const matched = (0, $b28f999d37dccebe$export$4659b591c19bdf3d)((0, $9636c8954d640602$export$b6c59b989905b650).fromSource("(a (q . (: . sexp)) (: . args))"), program);
      if (!matched) return program;
      const originalArgs = matched["args"];
      const originalCall = matched["sexp"];
      const newEvalProgramArgs = $a985f73a592474fb$export$f44402eed32c89db(originalCall, originalArgs);
      if ($a985f73a592474fb$export$6eee28b7ff726723(newEvalProgramArgs)) return $a985f73a592474fb$export$767e25f35e0954(newEvalProgramArgs, evalAsProgram);
      const newOperands = newEvalProgramArgs.toList();
      const optOperands = newOperands.map((item) => $a985f73a592474fb$export$767e25f35e0954(item, evalAsProgram));
      const nonConstantCount = optOperands.filter((item) => item.isCons && (item.first.isCons || !(0, $fpZC2$chiabls.bytesEqual)(item.first.atom, (0, $69b3f00f8a7733d7$export$2ede34752a982e57)))).length;
      if (nonConstantCount < 1) return (0, $9636c8954d640602$export$b6c59b989905b650).fromList(optOperands);
      return program;
    }
    function $a985f73a592474fb$export$2da8b1cb5a5c1650(program, evalAsProgram) {
      if (!program.isCons) return program;
      const operator = program.first;
      if (operator.isAtom && (0, $fpZC2$chiabls.bytesEqual)(operator.atom, (0, $69b3f00f8a7733d7$export$2ede34752a982e57))) return program;
      return (0, $9636c8954d640602$export$b6c59b989905b650).fromList(program.toList().map((item) => $a985f73a592474fb$export$767e25f35e0954(item, evalAsProgram)));
    }
    function $a985f73a592474fb$export$6f76a56e2909b861(program, _evalAsProgram) {
      let matched = (0, $b28f999d37dccebe$export$4659b591c19bdf3d)((0, $9636c8954d640602$export$b6c59b989905b650).fromSource("(f (c (: . first) (: . rest)))"), program);
      if (matched) return matched["first"];
      matched = (0, $b28f999d37dccebe$export$4659b591c19bdf3d)((0, $9636c8954d640602$export$b6c59b989905b650).fromSource("(r (c (: . first) (: . rest)))"), program);
      if (matched) return matched["rest"];
      return program;
    }
    function $a985f73a592474fb$export$ea1c1c64007bc24b(program, _evalAsProgram) {
      let matched = (0, $b28f999d37dccebe$export$4659b591c19bdf3d)((0, $9636c8954d640602$export$b6c59b989905b650).fromSource("(f ($ . atom))"), program);
      if (matched && !matched["atom"].isNull) {
        const node = new (0, $3f2125465f2f6884$export$119c224dc5fdfaa6)(matched["atom"].toBigInt()).add((0, $3f2125465f2f6884$export$119c224dc5fdfaa6).left);
        return (0, $9636c8954d640602$export$b6c59b989905b650).fromBytes(node.asPath());
      }
      matched = (0, $b28f999d37dccebe$export$4659b591c19bdf3d)((0, $9636c8954d640602$export$b6c59b989905b650).fromSource("(r ($ . atom))"), program);
      if (matched && !matched["atom"].isNull) {
        const node = new (0, $3f2125465f2f6884$export$119c224dc5fdfaa6)(matched["atom"].toBigInt()).add((0, $3f2125465f2f6884$export$119c224dc5fdfaa6).right);
        return (0, $9636c8954d640602$export$b6c59b989905b650).fromBytes(node.asPath());
      }
      return program;
    }
    function $a985f73a592474fb$export$32ec3f290cb70d5a(program, _evalAsProgram) {
      const matched = (0, $b28f999d37dccebe$export$4659b591c19bdf3d)((0, $9636c8954d640602$export$b6c59b989905b650).fromSource("(q . 0)"), program);
      if (matched) return (0, $9636c8954d640602$export$b6c59b989905b650).nil;
      return program;
    }
    function $a985f73a592474fb$export$b4f30947615ab0c1(program, _evalAsProgram) {
      const matched = (0, $b28f999d37dccebe$export$4659b591c19bdf3d)((0, $9636c8954d640602$export$b6c59b989905b650).fromSource("(a 0 . (: . rest))"), program);
      if (matched) return (0, $9636c8954d640602$export$b6c59b989905b650).nil;
      return program;
    }
    function $a985f73a592474fb$export$767e25f35e0954(program, evalAsProgram) {
      if (program.isAtom) return program;
      const optimizers = [
        $a985f73a592474fb$export$6f76a56e2909b861,
        $a985f73a592474fb$export$4b7046275197ae1c,
        $a985f73a592474fb$export$6e8a6ed2471a063e,
        $a985f73a592474fb$export$47ba71260b7e33dc,
        $a985f73a592474fb$export$2da8b1cb5a5c1650,
        $a985f73a592474fb$export$ea1c1c64007bc24b,
        $a985f73a592474fb$export$32ec3f290cb70d5a,
        $a985f73a592474fb$export$b4f30947615ab0c1
      ];
      while (program.isCons) {
        const startProgram = program;
        for (const optimizer of optimizers) {
          program = optimizer(program, evalAsProgram);
          if (!startProgram.equals(program)) break;
        }
        if (startProgram.equals(program)) return program;
      }
      return program;
    }
    function $a985f73a592474fb$export$f47d6a487cee0a73(runProgram) {
      return (args) => {
        return {
          value: $a985f73a592474fb$export$767e25f35e0954(args.first, runProgram),
          cost: 1n
        };
      };
    }
    var $d81bf0ff4dbe2d6e$var$mainName = "";
    function $d81bf0ff4dbe2d6e$export$9896244d8c99a4d0(items) {
      if (items.length === 0) return (0, $9636c8954d640602$export$b6c59b989905b650).nil;
      else if (items.length === 1) return items[0];
      const halfSize = items.length >> 1;
      return (0, $9636c8954d640602$export$b6c59b989905b650).cons($d81bf0ff4dbe2d6e$export$9896244d8c99a4d0(items.slice(0, halfSize)), $d81bf0ff4dbe2d6e$export$9896244d8c99a4d0(items.slice(halfSize)));
    }
    function $d81bf0ff4dbe2d6e$export$50a2a08029067c58(items) {
      if (items.length === 0) return (0, $9636c8954d640602$export$b6c59b989905b650).fromList([
        (0, $ec4be0719743fcdf$export$15d71aa2e69a0c29)((0, $9636c8954d640602$export$b6c59b989905b650).nil)
      ]);
      else if (items.length === 1) return items[0];
      const halfSize = items.length >> 1;
      return (0, $9636c8954d640602$export$b6c59b989905b650).fromList([
        (0, $9636c8954d640602$export$b6c59b989905b650).fromBytes((0, $69b3f00f8a7733d7$export$2542912e97e68f4e)),
        $d81bf0ff4dbe2d6e$export$50a2a08029067c58(items.slice(0, halfSize)),
        $d81bf0ff4dbe2d6e$export$50a2a08029067c58(items.slice(halfSize))
      ]);
    }
    function $d81bf0ff4dbe2d6e$export$bffa455ba8c619a6(program) {
      if (program.isCons) return [
        ...$d81bf0ff4dbe2d6e$export$bffa455ba8c619a6(program.first),
        ...$d81bf0ff4dbe2d6e$export$bffa455ba8c619a6(program.rest)
      ];
      else return [
        program.toText()
      ];
    }
    function $d81bf0ff4dbe2d6e$export$fddefddb691e6258(functions, constants, macros) {
      const macrosAsDict = {};
      for (const item of macros) macrosAsDict[item.rest.first.toText()] = item;
      const possibleSymbols = new (0, $17c1ef024405b6ea$export$a4dd1bf5a8aa5573)(Object.keys(functions));
      possibleSymbols.update(new (0, $17c1ef024405b6ea$export$a4dd1bf5a8aa5573)(Object.keys(constants)));
      let newNames = new (0, $17c1ef024405b6ea$export$a4dd1bf5a8aa5573)([
        $d81bf0ff4dbe2d6e$var$mainName
      ]);
      const usedNames = new (0, $17c1ef024405b6ea$export$a4dd1bf5a8aa5573)(newNames);
      while (newNames.size) {
        const priorNewNames = new (0, $17c1ef024405b6ea$export$a4dd1bf5a8aa5573)(newNames);
        newNames = new (0, $17c1ef024405b6ea$export$a4dd1bf5a8aa5573)();
        for (const item of priorNewNames) {
          for (const group of [
            functions,
            macrosAsDict
          ]) if (item in group) newNames.update(new (0, $17c1ef024405b6ea$export$a4dd1bf5a8aa5573)($d81bf0ff4dbe2d6e$export$bffa455ba8c619a6(group[item])));
        }
        newNames.differenceUpdate(usedNames);
        usedNames.update(newNames);
      }
      usedNames.intersectionUpdate(possibleSymbols);
      usedNames.delete($d81bf0ff4dbe2d6e$var$mainName);
      return usedNames.sort((a, b) => (0, $b8dc7cb54aa9eaa3$export$633da1651c3bd3f9)(a, b));
    }
    function $d81bf0ff4dbe2d6e$export$8bf632d40c0a848b(name, namespace, functions, constants, macros, runProgram) {
      const program = (0, $9636c8954d640602$export$b6c59b989905b650).fromSource("(_read (_full_path_for_name 1))");
      const output = runProgram(program, name).value;
      for (const item of output.toList()) $d81bf0ff4dbe2d6e$export$7d6a67d8e26b1886(item, namespace, functions, constants, macros, runProgram);
    }
    function $d81bf0ff4dbe2d6e$export$66c2bd7a184bdde8(program, args) {
      if (program.isCons) return (0, $9636c8954d640602$export$b6c59b989905b650).cons($d81bf0ff4dbe2d6e$export$66c2bd7a184bdde8(program.first, args), $d81bf0ff4dbe2d6e$export$66c2bd7a184bdde8(program.rest, args));
      else if (args.includes(program.toText())) return (0, $9636c8954d640602$export$b6c59b989905b650).fromList([
        (0, $9636c8954d640602$export$b6c59b989905b650).fromText("unquote"),
        program
      ]);
      return program;
    }
    function $d81bf0ff4dbe2d6e$export$3d84838a88a77879(program) {
      const second = program.rest;
      const third = second.rest;
      const items = [
        (0, $9636c8954d640602$export$b6c59b989905b650).fromText("defmacro"),
        second.first,
        third.first
      ];
      const code = third.rest.first;
      const args = $d81bf0ff4dbe2d6e$export$bffa455ba8c619a6(third.first).filter((item) => item.length);
      const unquotedCode = $d81bf0ff4dbe2d6e$export$66c2bd7a184bdde8(code, args);
      items.push((0, $9636c8954d640602$export$b6c59b989905b650).fromList([
        (0, $9636c8954d640602$export$b6c59b989905b650).fromText("qq"),
        unquotedCode
      ]));
      return (0, $9636c8954d640602$export$b6c59b989905b650).fromList(items);
    }
    function $d81bf0ff4dbe2d6e$export$7d6a67d8e26b1886(declarationProgram, namespace, functions, constants, macros, runProgram) {
      const op = declarationProgram.first.toText();
      const nameProgram = declarationProgram.rest.first;
      if (op === "include") {
        $d81bf0ff4dbe2d6e$export$8bf632d40c0a848b(nameProgram, namespace, functions, constants, macros, runProgram);
        return;
      }
      const name = nameProgram.toText();
      if (namespace.has(name)) throw new Error(`Symbol ${JSON.stringify(name)} redefined.`);
      namespace.add(name);
      if (op === "defmacro") macros.push(declarationProgram);
      else if (op === "defun") functions[name] = declarationProgram.rest.rest;
      else if (op === "defun-inline") macros.push($d81bf0ff4dbe2d6e$export$3d84838a88a77879(declarationProgram));
      else if (op === "defconstant") constants[name] = (0, $ec4be0719743fcdf$export$15d71aa2e69a0c29)(declarationProgram.rest.rest.first);
      else throw new Error(`Expected "defun", "defun-inline", "defmacro", or "defconstant", but got ${JSON.stringify(op)}.`);
    }
    function $d81bf0ff4dbe2d6e$export$9665f6d487c71a5a(args, runProgram) {
      const functions = {};
      const constants = {};
      const macros = [];
      const mainLocalArguments = args.first;
      const namespace = new (0, $17c1ef024405b6ea$export$a4dd1bf5a8aa5573)();
      while (true) {
        args = args.rest;
        if (args.rest.isNull) break;
        $d81bf0ff4dbe2d6e$export$7d6a67d8e26b1886(args.first, namespace, functions, constants, macros, runProgram);
      }
      const uncompiledMain = args.first;
      functions[$d81bf0ff4dbe2d6e$var$mainName] = (0, $9636c8954d640602$export$b6c59b989905b650).fromList([
        mainLocalArguments,
        uncompiledMain
      ]);
      return [
        functions,
        constants,
        macros
      ];
    }
    function $d81bf0ff4dbe2d6e$export$bb136ef67aed6c8c(tree, rootNode) {
      if (tree.isNull) return (0, $9636c8954d640602$export$b6c59b989905b650).nil;
      else if (!tree.isCons) return (0, $9636c8954d640602$export$b6c59b989905b650).fromList([
        (0, $9636c8954d640602$export$b6c59b989905b650).fromList([
          tree,
          (0, $9636c8954d640602$export$b6c59b989905b650).fromBytes(rootNode.asPath())
        ])
      ]);
      const left = $d81bf0ff4dbe2d6e$export$bb136ef67aed6c8c(tree.first, rootNode.add((0, $3f2125465f2f6884$export$119c224dc5fdfaa6).left));
      const right = $d81bf0ff4dbe2d6e$export$bb136ef67aed6c8c(tree.rest, rootNode.add((0, $3f2125465f2f6884$export$119c224dc5fdfaa6).right));
      return (0, $9636c8954d640602$export$b6c59b989905b650).fromList([
        ...left.toList(),
        ...right.toList()
      ]);
    }
    function $d81bf0ff4dbe2d6e$export$3b9592ef1cecfca1(macroLookup, macros, runProgram) {
      let macroLookupProgram = (0, $ec4be0719743fcdf$export$15d71aa2e69a0c29)(macroLookup);
      for (const macro of macros) {
        macroLookupProgram = (0, $ec4be0719743fcdf$export$57e68749c88bb462)((0, $9636c8954d640602$export$b6c59b989905b650).fromList([
          (0, $9636c8954d640602$export$b6c59b989905b650).fromText("opt"),
          (0, $9636c8954d640602$export$b6c59b989905b650).fromList([
            (0, $9636c8954d640602$export$b6c59b989905b650).fromText("com"),
            (0, $ec4be0719743fcdf$export$15d71aa2e69a0c29)((0, $9636c8954d640602$export$b6c59b989905b650).fromList([
              (0, $9636c8954d640602$export$b6c59b989905b650).fromBytes((0, $69b3f00f8a7733d7$export$2542912e97e68f4e)),
              macro,
              macroLookupProgram
            ])),
            macroLookupProgram
          ])
        ]), (0, $9636c8954d640602$export$b6c59b989905b650).fromBytes((0, $3f2125465f2f6884$export$119c224dc5fdfaa6).top.asPath()));
        macroLookupProgram = (0, $a985f73a592474fb$export$767e25f35e0954)(macroLookupProgram, runProgram);
      }
      return macroLookupProgram;
    }
    function $d81bf0ff4dbe2d6e$export$7eeeed3abcd324fe(functions, macroLookupProgram, constantSymbolTable, argsRootNode) {
      const compiledFunctions = {};
      for (const [name, lambdaExpression] of Object.entries(functions)) {
        const localSymbolTable = $d81bf0ff4dbe2d6e$export$bb136ef67aed6c8c(lambdaExpression.first, argsRootNode);
        const allSymbols = (0, $9636c8954d640602$export$b6c59b989905b650).fromList([
          ...localSymbolTable.toList(),
          ...constantSymbolTable.toList()
        ]);
        compiledFunctions[name] = (0, $9636c8954d640602$export$b6c59b989905b650).fromList([
          (0, $9636c8954d640602$export$b6c59b989905b650).fromText("opt"),
          (0, $9636c8954d640602$export$b6c59b989905b650).fromList([
            (0, $9636c8954d640602$export$b6c59b989905b650).fromText("com"),
            (0, $ec4be0719743fcdf$export$15d71aa2e69a0c29)(lambdaExpression.rest.first),
            macroLookupProgram,
            (0, $ec4be0719743fcdf$export$15d71aa2e69a0c29)(allSymbols)
          ])
        ]);
      }
      return compiledFunctions;
    }
    function $d81bf0ff4dbe2d6e$export$19b97198b397b1c4(args, macroLookup, _symbolTable, runProgram) {
      const [functions, constants, macros] = $d81bf0ff4dbe2d6e$export$9665f6d487c71a5a(args, runProgram);
      const macroLookupProgram = $d81bf0ff4dbe2d6e$export$3b9592ef1cecfca1(macroLookup, macros, runProgram);
      const allConstantNames = $d81bf0ff4dbe2d6e$export$fddefddb691e6258(functions, constants, macros);
      const hasConstantTree = allConstantNames.size > 0;
      const constantTree = $d81bf0ff4dbe2d6e$export$9896244d8c99a4d0([
        ...allConstantNames.map((item) => (0, $9636c8954d640602$export$b6c59b989905b650).fromText(item))
      ]);
      const constantRootNode = (0, $3f2125465f2f6884$export$119c224dc5fdfaa6).left;
      const argsRootNode = hasConstantTree ? (0, $3f2125465f2f6884$export$119c224dc5fdfaa6).right : (0, $3f2125465f2f6884$export$119c224dc5fdfaa6).top;
      const constantSymbolTable = $d81bf0ff4dbe2d6e$export$bb136ef67aed6c8c(constantTree, constantRootNode);
      const compiledFunctions = $d81bf0ff4dbe2d6e$export$7eeeed3abcd324fe(functions, macroLookupProgram, constantSymbolTable, argsRootNode);
      const mainPathSource = compiledFunctions[$d81bf0ff4dbe2d6e$var$mainName].toString();
      let argTreeSource;
      if (hasConstantTree) {
        const allConstantsLookup = {};
        for (const [key, value] of Object.entries(compiledFunctions)) if (allConstantNames.has(key)) allConstantsLookup[key] = value;
        Object.assign(allConstantsLookup, constants);
        const allConstantsList = [
          ...allConstantNames
        ].map((item) => allConstantsLookup[item]);
        const allConstantsTreeProgram = $d81bf0ff4dbe2d6e$export$50a2a08029067c58(allConstantsList);
        const allConstantsTreeSource = allConstantsTreeProgram.toString();
        argTreeSource = `(c ${allConstantsTreeSource} 1)`;
      } else argTreeSource = "1";
      return (0, $9636c8954d640602$export$b6c59b989905b650).fromSource(`(opt (q . (a ${mainPathSource} ${argTreeSource})))`);
    }
    var $6edfc72fb8768007$var$passThroughOperators = new (0, $17c1ef024405b6ea$export$a4dd1bf5a8aa5573)([
      ...Object.values((0, $94ca46fd7d128ba2$export$eebaaf2b24d91f63)).map((value) => (0, $fpZC2$chiabls.toHex)((0, $fpZC2$chiabls.encodeBigInt)(value))),
      (0, $fpZC2$chiabls.toHex)(new TextEncoder().encode("com")),
      (0, $fpZC2$chiabls.toHex)(new TextEncoder().encode("opt"))
    ]);
    function $6edfc72fb8768007$export$4f014e0e2f9a3439(args, macroLookup, symbolTable, runProgram, level = 1) {
      function com(program2) {
        return $6edfc72fb8768007$export$6469419774d99a46(program2, macroLookup, symbolTable, runProgram);
      }
      const program = args.first;
      if (!program.isCons) return (0, $ec4be0719743fcdf$export$15d71aa2e69a0c29)(program);
      if (!program.first.isCons) {
        const op = program.first.toText();
        if (op === "qq") {
          const expression = $6edfc72fb8768007$export$4f014e0e2f9a3439(program.rest, macroLookup, symbolTable, runProgram, level + 1);
          return com((0, $9636c8954d640602$export$b6c59b989905b650).fromList([
            (0, $9636c8954d640602$export$b6c59b989905b650).fromBytes((0, $69b3f00f8a7733d7$export$2542912e97e68f4e)),
            (0, $9636c8954d640602$export$b6c59b989905b650).fromText(op),
            (0, $9636c8954d640602$export$b6c59b989905b650).fromList([
              (0, $9636c8954d640602$export$b6c59b989905b650).fromBytes((0, $69b3f00f8a7733d7$export$2542912e97e68f4e)),
              expression,
              (0, $ec4be0719743fcdf$export$15d71aa2e69a0c29)((0, $9636c8954d640602$export$b6c59b989905b650).nil)
            ])
          ]));
        } else if (op === "unquote") {
          if (level === 1) return com(program.rest.first);
          const expression = $6edfc72fb8768007$export$4f014e0e2f9a3439(program.rest, macroLookup, symbolTable, runProgram, level - 1);
          return com((0, $9636c8954d640602$export$b6c59b989905b650).fromList([
            (0, $9636c8954d640602$export$b6c59b989905b650).fromBytes((0, $69b3f00f8a7733d7$export$2542912e97e68f4e)),
            (0, $9636c8954d640602$export$b6c59b989905b650).fromText(op),
            (0, $9636c8954d640602$export$b6c59b989905b650).fromList([
              (0, $9636c8954d640602$export$b6c59b989905b650).fromBytes((0, $69b3f00f8a7733d7$export$2542912e97e68f4e)),
              expression,
              (0, $ec4be0719743fcdf$export$15d71aa2e69a0c29)((0, $9636c8954d640602$export$b6c59b989905b650).nil)
            ])
          ]));
        }
      }
      const first = com((0, $9636c8954d640602$export$b6c59b989905b650).fromList([
        (0, $9636c8954d640602$export$b6c59b989905b650).fromText("qq"),
        program.first
      ]));
      const rest = com((0, $9636c8954d640602$export$b6c59b989905b650).fromList([
        (0, $9636c8954d640602$export$b6c59b989905b650).fromText("qq"),
        program.rest
      ]));
      return (0, $9636c8954d640602$export$b6c59b989905b650).fromList([
        (0, $9636c8954d640602$export$b6c59b989905b650).fromBytes((0, $69b3f00f8a7733d7$export$2542912e97e68f4e)),
        first,
        rest
      ]);
    }
    function $6edfc72fb8768007$export$10e4a0f3245dd758(_args, macroLookup, _symbolTable, _runProgram) {
      return (0, $ec4be0719743fcdf$export$15d71aa2e69a0c29)(macroLookup);
    }
    function $6edfc72fb8768007$export$11b536640056999f(_args, _macroLookup, symbolTable, _runProgram) {
      return (0, $ec4be0719743fcdf$export$15d71aa2e69a0c29)(symbolTable);
    }
    var $6edfc72fb8768007$export$77f1bb37b4f1d5ec = {
      qq: $6edfc72fb8768007$export$4f014e0e2f9a3439,
      macros: $6edfc72fb8768007$export$10e4a0f3245dd758,
      symbols: $6edfc72fb8768007$export$11b536640056999f,
      lambda: (0, $d81bf0ff4dbe2d6e$export$19b97198b397b1c4),
      mod: (0, $d81bf0ff4dbe2d6e$export$19b97198b397b1c4)
    };
    function $6edfc72fb8768007$export$1e276181c3bc016e(program, _macroLookup, _symbolTable, _runProgram) {
      if (program.isAtom) return program;
      else if (program.first.isAtom && program.first.toText() === "quote") {
        if (!program.rest.rest.isNull) throw new Error(`Compilation error while compiling ${program}. Quote takes exactly one argument${program.positionSuffix}.`);
        return (0, $ec4be0719743fcdf$export$15d71aa2e69a0c29)($6edfc72fb8768007$export$1e276181c3bc016e(program.rest.first));
      } else return (0, $9636c8954d640602$export$b6c59b989905b650).cons($6edfc72fb8768007$export$1e276181c3bc016e(program.first), $6edfc72fb8768007$export$1e276181c3bc016e(program.rest));
    }
    function $6edfc72fb8768007$export$6469419774d99a46(program, macroLookup, symbolTable, runProgram) {
      program = $6edfc72fb8768007$export$1e276181c3bc016e(program, macroLookup, symbolTable, runProgram);
      if (!program.isCons) {
        const atom2 = program.toText();
        if (atom2 === "@") return (0, $9636c8954d640602$export$b6c59b989905b650).fromBytes((0, $3f2125465f2f6884$export$119c224dc5fdfaa6).top.asPath());
        for (const pair of symbolTable.toList()) {
          const symbol = pair.first;
          const value = pair.rest.first;
          if (symbol.isAtom && symbol.toText() === atom2) return value;
        }
        return (0, $ec4be0719743fcdf$export$15d71aa2e69a0c29)(program);
      }
      const operator = program.first;
      if (operator.isCons) {
        const inner = (0, $ec4be0719743fcdf$export$57e68749c88bb462)((0, $9636c8954d640602$export$b6c59b989905b650).fromList([
          (0, $9636c8954d640602$export$b6c59b989905b650).fromText("com"),
          (0, $ec4be0719743fcdf$export$15d71aa2e69a0c29)(operator),
          (0, $ec4be0719743fcdf$export$15d71aa2e69a0c29)(macroLookup),
          (0, $ec4be0719743fcdf$export$15d71aa2e69a0c29)(symbolTable)
        ]), (0, $9636c8954d640602$export$b6c59b989905b650).fromBytes((0, $3f2125465f2f6884$export$119c224dc5fdfaa6).top.asPath()));
        return (0, $9636c8954d640602$export$b6c59b989905b650).fromList([
          inner
        ]);
      }
      const atom = operator.toText();
      for (const macroPair of macroLookup.toList()) if (macroPair.first.isAtom && macroPair.first.toText() === atom) {
        const macroCode = macroPair.rest.first;
        const postProgram = (0, $ec4be0719743fcdf$export$9692bc1ad98955fc)(macroCode, program.rest);
        const result2 = (0, $ec4be0719743fcdf$export$57e68749c88bb462)((0, $9636c8954d640602$export$b6c59b989905b650).fromList([
          (0, $9636c8954d640602$export$b6c59b989905b650).fromText("com"),
          postProgram,
          (0, $ec4be0719743fcdf$export$15d71aa2e69a0c29)(macroLookup),
          (0, $ec4be0719743fcdf$export$15d71aa2e69a0c29)(symbolTable)
        ]), (0, $9636c8954d640602$export$b6c59b989905b650).fromBytes((0, $3f2125465f2f6884$export$119c224dc5fdfaa6).top.asPath()));
        return result2;
      }
      if (atom in $6edfc72fb8768007$export$77f1bb37b4f1d5ec) {
        const compiler = $6edfc72fb8768007$export$77f1bb37b4f1d5ec[atom];
        const postProgram = compiler(program.rest, macroLookup, symbolTable, runProgram);
        return (0, $ec4be0719743fcdf$export$57e68749c88bb462)((0, $ec4be0719743fcdf$export$15d71aa2e69a0c29)(postProgram), (0, $9636c8954d640602$export$b6c59b989905b650).fromBytes((0, $3f2125465f2f6884$export$119c224dc5fdfaa6).top.asPath()));
      }
      if ((0, $fpZC2$chiabls.bytesEqual)(operator.atom, (0, $69b3f00f8a7733d7$export$2ede34752a982e57))) return program;
      const compiledArgs = program.rest.toList().map((item) => $6edfc72fb8768007$export$6469419774d99a46(item, macroLookup, symbolTable, runProgram));
      let result = (0, $9636c8954d640602$export$b6c59b989905b650).fromList([
        operator,
        ...compiledArgs
      ]);
      if ($6edfc72fb8768007$var$passThroughOperators.has((0, $fpZC2$chiabls.toHex)(new TextEncoder().encode(atom))) || atom.startsWith("_")) return result;
      for (const item of symbolTable.toList()) {
        const [symbol, value] = item.toList();
        if (!symbol.isAtom) continue;
        const symbolText = symbol.toText();
        if (symbolText === "*") return result;
        else if (symbolText === atom) {
          const newArgs = (0, $ec4be0719743fcdf$export$57e68749c88bb462)((0, $9636c8954d640602$export$b6c59b989905b650).fromList([
            (0, $9636c8954d640602$export$b6c59b989905b650).fromText("opt"),
            (0, $9636c8954d640602$export$b6c59b989905b650).fromList([
              (0, $9636c8954d640602$export$b6c59b989905b650).fromText("com"),
              (0, $ec4be0719743fcdf$export$15d71aa2e69a0c29)((0, $9636c8954d640602$export$b6c59b989905b650).fromList([
                (0, $9636c8954d640602$export$b6c59b989905b650).fromText("list"),
                ...program.rest.toList()
              ])),
              (0, $ec4be0719743fcdf$export$15d71aa2e69a0c29)(macroLookup),
              (0, $ec4be0719743fcdf$export$15d71aa2e69a0c29)(symbolTable)
            ])
          ]), (0, $9636c8954d640602$export$b6c59b989905b650).fromBytes((0, $3f2125465f2f6884$export$119c224dc5fdfaa6).top.asPath()));
          return (0, $9636c8954d640602$export$b6c59b989905b650).fromList([
            (0, $9636c8954d640602$export$b6c59b989905b650).fromBytes((0, $69b3f00f8a7733d7$export$688e2fe60354a4fd)),
            value,
            (0, $9636c8954d640602$export$b6c59b989905b650).fromList([
              (0, $9636c8954d640602$export$b6c59b989905b650).fromBytes((0, $69b3f00f8a7733d7$export$2542912e97e68f4e)),
              (0, $9636c8954d640602$export$b6c59b989905b650).fromBytes((0, $3f2125465f2f6884$export$119c224dc5fdfaa6).left.asPath()),
              newArgs
            ])
          ]);
        }
      }
      throw new Error(`Can't compile unknown operator ${program}${program.positionSuffix}.`);
    }
    function $6edfc72fb8768007$export$5af009c3dc40b1bc(runProgram) {
      return (sexp) => {
        const prog = sexp.first;
        let symbolTable = (0, $9636c8954d640602$export$b6c59b989905b650).nil;
        let macroLookup;
        if (!sexp.rest.isNull) {
          macroLookup = sexp.rest.first;
          if (!sexp.rest.rest.isNull) symbolTable = sexp.rest.rest.first;
        } else macroLookup = (0, $c1f25f83b21fbca5$export$35ac38cd538ce3a4)(runProgram);
        return {
          value: $6edfc72fb8768007$export$6469419774d99a46(prog, macroLookup, symbolTable, runProgram),
          cost: 1n
        };
      };
    }
    var $50d1f9204136c73a$export$5fe13095c61781e4 = {
      if: 33n,
      cons: 50n,
      first: 30n,
      rest: 30n,
      listp: 19n,
      mallocPerByte: 10n,
      arithBase: 99n,
      arithPerByte: 3n,
      arithPerArg: 320n,
      logBase: 100n,
      logPerByte: 3n,
      logPerArg: 264n,
      grsBase: 117n,
      grsPerByte: 1n,
      eqBase: 117n,
      eqPerByte: 1n,
      grBase: 498n,
      grPerByte: 2n,
      divmodBase: 1116n,
      divmodPerByte: 6n,
      divBase: 988n,
      divPerByte: 4n,
      sha256Base: 87n,
      sha256PerByte: 2n,
      sha256PerArg: 134n,
      pointAddBase: 101094n,
      pointAddPerArg: 1343980n,
      pubkeyBase: 1325730n,
      pubkeyPerByte: 38n,
      mulBase: 92n,
      mulPerOp: 885n,
      mulLinearPerByte: 6n,
      mulSquarePerByteDivider: 128n,
      strlenBase: 173n,
      strlenPerByte: 1n,
      pathLookupBase: 40n,
      pathLookupPerLeg: 4n,
      pathLookupPerZeroByte: 4n,
      concatBase: 142n,
      concatPerByte: 3n,
      concatPerArg: 135n,
      boolBase: 200n,
      boolPerArg: 300n,
      ashiftBase: 596n,
      ashiftPerByte: 3n,
      lshiftBase: 277n,
      lshiftPerByte: 3n,
      lognotBase: 331n,
      lognotPerByte: 3n,
      apply: 90n,
      quote: 20n
    };
    function $b45cfe84191f72e9$export$2370125adba2cb1e(byte) {
      byte |= byte >> 1;
      byte |= byte >> 2;
      byte |= byte >> 4;
      return byte + 1 >> 1;
    }
    function $b45cfe84191f72e9$export$520469ab96a2a022(value, environment) {
      let cost = (0, $50d1f9204136c73a$export$5fe13095c61781e4).pathLookupBase + (0, $50d1f9204136c73a$export$5fe13095c61781e4).pathLookupPerLeg;
      if (value.isNull) return {
        value: (0, $9636c8954d640602$export$b6c59b989905b650).nil,
        cost
      };
      let endByteCursor = 0;
      const atom = value.atom;
      while (endByteCursor < atom.length && atom[endByteCursor] === 0) endByteCursor++;
      cost += BigInt(endByteCursor) * (0, $50d1f9204136c73a$export$5fe13095c61781e4).pathLookupPerZeroByte;
      if (endByteCursor === atom.length) return {
        value: (0, $9636c8954d640602$export$b6c59b989905b650).nil,
        cost
      };
      const endBitMask = $b45cfe84191f72e9$export$2370125adba2cb1e(atom[endByteCursor]);
      let byteCursor = atom.length - 1;
      let bitMask = 1;
      while (byteCursor > endByteCursor || bitMask < endBitMask) {
        if (environment.isAtom) throw new Error(`Cannot traverse into ${environment}${environment.positionSuffix}.`);
        if ((atom[byteCursor] & bitMask) !== 0) environment = environment.rest;
        else environment = environment.first;
        cost += (0, $50d1f9204136c73a$export$5fe13095c61781e4).pathLookupPerLeg;
        bitMask <<= 1;
        if (bitMask === 256) {
          byteCursor--;
          bitMask = 1;
        }
      }
      return {
        value: environment,
        cost
      };
    }
    var $ee0ce775d2fb3caf$export$ccbce4efa7f8029b = {
      i: (args) => {
        const list = $ee0ce775d2fb3caf$export$effcdbd76139450(args, "i", 3);
        return {
          value: list[0].isNull ? list[2] : list[1],
          cost: (0, $50d1f9204136c73a$export$5fe13095c61781e4).if
        };
      },
      c: (args) => {
        const list = $ee0ce775d2fb3caf$export$effcdbd76139450(args, "c", 2);
        return {
          value: (0, $9636c8954d640602$export$b6c59b989905b650).cons(list[0], list[1]),
          cost: (0, $50d1f9204136c73a$export$5fe13095c61781e4).cons
        };
      },
      f: (args) => {
        const list = $ee0ce775d2fb3caf$export$effcdbd76139450(args, "f", 1, "cons");
        return {
          value: list[0].first,
          cost: (0, $50d1f9204136c73a$export$5fe13095c61781e4).first
        };
      },
      r: (args) => {
        const list = $ee0ce775d2fb3caf$export$effcdbd76139450(args, "r", 1, "cons");
        return {
          value: list[0].rest,
          cost: (0, $50d1f9204136c73a$export$5fe13095c61781e4).rest
        };
      },
      l: (args) => {
        const list = $ee0ce775d2fb3caf$export$effcdbd76139450(args, "l", 1);
        return {
          value: (0, $9636c8954d640602$export$b6c59b989905b650).fromBool(list[0].isCons),
          cost: (0, $50d1f9204136c73a$export$5fe13095c61781e4).listp
        };
      },
      x: (args) => {
        throw new Error(`The error ${args} was raised${args.positionSuffix}.`);
      },
      "=": (args) => {
        const list = $ee0ce775d2fb3caf$export$effcdbd76139450(args, "=", 2, "atom");
        return {
          value: (0, $9636c8954d640602$export$b6c59b989905b650).fromBool((0, $fpZC2$chiabls.bytesEqual)(list[0].atom, list[1].atom)),
          cost: (0, $50d1f9204136c73a$export$5fe13095c61781e4).eqBase + (BigInt(list[0].atom.length) + BigInt(list[1].atom.length)) * (0, $50d1f9204136c73a$export$5fe13095c61781e4).eqPerByte
        };
      },
      sha256: (args) => {
        const list = $ee0ce775d2fb3caf$export$effcdbd76139450(args, "sha256", void 0, "atom");
        let cost = (0, $50d1f9204136c73a$export$5fe13095c61781e4).sha256Base;
        let argLength = 0;
        const bytes = [];
        for (const item of list) {
          for (const byte of item.atom) bytes.push(byte);
          argLength += item.atom.length;
          cost += (0, $50d1f9204136c73a$export$5fe13095c61781e4).sha256PerArg;
        }
        cost += BigInt(argLength) * (0, $50d1f9204136c73a$export$5fe13095c61781e4).sha256PerByte;
        return $ee0ce775d2fb3caf$export$c85cac6a8d81208f({
          value: (0, $9636c8954d640602$export$b6c59b989905b650).fromBytes((0, $fpZC2$chiabls.hash256)(Uint8Array.from(bytes))),
          cost
        });
      },
      "+": (args) => {
        const list = $ee0ce775d2fb3caf$export$effcdbd76139450(args, "+", void 0, "atom");
        let total = 0n;
        let cost = (0, $50d1f9204136c73a$export$5fe13095c61781e4).arithBase;
        let argSize = 0;
        for (const item of list) {
          total += item.toBigInt();
          argSize += item.atom.length;
          cost += (0, $50d1f9204136c73a$export$5fe13095c61781e4).arithPerArg;
        }
        cost += BigInt(argSize) * (0, $50d1f9204136c73a$export$5fe13095c61781e4).arithPerByte;
        return $ee0ce775d2fb3caf$export$c85cac6a8d81208f({
          value: (0, $9636c8954d640602$export$b6c59b989905b650).fromBigInt(total),
          cost
        });
      },
      "-": (args) => {
        let cost = (0, $50d1f9204136c73a$export$5fe13095c61781e4).arithBase;
        if (args.isNull) return {
          value: (0, $9636c8954d640602$export$b6c59b989905b650).nil,
          cost
        };
        const list = $ee0ce775d2fb3caf$export$effcdbd76139450(args, "-", void 0, "atom");
        let total = 0n;
        let sign = 1n;
        let argSize = 0;
        for (const item of list) {
          total += sign * item.toBigInt();
          sign = -1n;
          argSize += item.atom.length;
          cost += (0, $50d1f9204136c73a$export$5fe13095c61781e4).arithPerArg;
        }
        cost += BigInt(argSize) * (0, $50d1f9204136c73a$export$5fe13095c61781e4).arithPerByte;
        return $ee0ce775d2fb3caf$export$c85cac6a8d81208f({
          value: (0, $9636c8954d640602$export$b6c59b989905b650).fromBigInt(total),
          cost
        });
      },
      "*": (args) => {
        const list = $ee0ce775d2fb3caf$export$effcdbd76139450(args, "*", void 0, "atom");
        let cost = (0, $50d1f9204136c73a$export$5fe13095c61781e4).mulBase;
        if (!list.length) return $ee0ce775d2fb3caf$export$c85cac6a8d81208f({
          value: (0, $9636c8954d640602$export$b6c59b989905b650).true,
          cost
        });
        let value = list[0].toBigInt();
        let size = list[0].atom.length;
        for (const item of list.slice(1)) {
          cost += (0, $50d1f9204136c73a$export$5fe13095c61781e4).mulPerOp + (BigInt(item.atom.length) + BigInt(size)) * (0, $50d1f9204136c73a$export$5fe13095c61781e4).mulLinearPerByte + BigInt(item.atom.length) * BigInt(size) / (0, $50d1f9204136c73a$export$5fe13095c61781e4).mulSquarePerByteDivider;
          value *= item.toBigInt();
          size = $ee0ce775d2fb3caf$export$2f0301b329918c24(value);
        }
        return $ee0ce775d2fb3caf$export$c85cac6a8d81208f({
          value: (0, $9636c8954d640602$export$b6c59b989905b650).fromBigInt(value),
          cost
        });
      },
      divmod: (args) => {
        const list = $ee0ce775d2fb3caf$export$effcdbd76139450(args, "divmod", 2, "atom");
        let cost = (0, $50d1f9204136c73a$export$5fe13095c61781e4).divmodBase;
        const numerator = list[0].toBigInt();
        const denominator = list[1].toBigInt();
        if (denominator === 0n) throw new Error(`Cannot divide by zero in "divmod" operator${args.positionSuffix}.`);
        cost += (BigInt(list[0].atom.length) + BigInt(list[1].atom.length)) * (0, $50d1f9204136c73a$export$5fe13095c61781e4).divmodPerByte;
        let quotientValue = numerator / denominator;
        const remainderValue = (0, $fpZC2$chiabls.mod)(numerator, denominator);
        if (numerator < 0n !== denominator < 0n && remainderValue !== 0n) quotientValue -= 1n;
        const quotient = (0, $9636c8954d640602$export$b6c59b989905b650).fromBigInt(quotientValue);
        const remainder = (0, $9636c8954d640602$export$b6c59b989905b650).fromBigInt(remainderValue);
        cost += (BigInt(quotient.atom.length) + BigInt(remainder.atom.length)) * (0, $50d1f9204136c73a$export$5fe13095c61781e4).mallocPerByte;
        return {
          value: (0, $9636c8954d640602$export$b6c59b989905b650).cons(quotient, remainder),
          cost
        };
      },
      "/": (args) => {
        const list = $ee0ce775d2fb3caf$export$effcdbd76139450(args, "/", 2, "atom");
        let cost = (0, $50d1f9204136c73a$export$5fe13095c61781e4).divBase;
        const numerator = list[0].toBigInt();
        const denominator = list[1].toBigInt();
        if (denominator === 0n) throw new Error(`Cannot divide by zero in "/" operator${args.positionSuffix}.`);
        cost += (BigInt(list[0].atom.length) + BigInt(list[1].atom.length)) * (0, $50d1f9204136c73a$export$5fe13095c61781e4).divPerByte;
        let quotientValue = numerator / denominator;
        const remainderValue = (0, $fpZC2$chiabls.mod)(numerator, denominator);
        if (numerator < 0n !== denominator < 0n && quotientValue < 0n) quotientValue -= 1n;
        const quotient = (0, $9636c8954d640602$export$b6c59b989905b650).fromBigInt(quotientValue);
        return $ee0ce775d2fb3caf$export$c85cac6a8d81208f({
          value: quotient,
          cost
        });
      },
      ">": (args) => {
        const list = $ee0ce775d2fb3caf$export$effcdbd76139450(args, ">", 2, "atom");
        const cost = (0, $50d1f9204136c73a$export$5fe13095c61781e4).grBase + (BigInt(list[0].atom.length) + BigInt(list[1].atom.length)) * (0, $50d1f9204136c73a$export$5fe13095c61781e4).grPerByte;
        return {
          value: (0, $9636c8954d640602$export$b6c59b989905b650).fromBool(list[0].toBigInt() > list[1].toBigInt()),
          cost
        };
      },
      ">s": (args) => {
        const list = $ee0ce775d2fb3caf$export$effcdbd76139450(args, ">s", 2, "atom");
        const cost = (0, $50d1f9204136c73a$export$5fe13095c61781e4).grsBase + (BigInt(list[0].atom.length) + BigInt(list[1].atom.length)) * (0, $50d1f9204136c73a$export$5fe13095c61781e4).grsPerByte;
        return {
          value: (0, $9636c8954d640602$export$b6c59b989905b650).fromBool(list[0].toHex().localeCompare(list[1].toHex()) === 1),
          cost
        };
      },
      pubkey_for_exp: (args) => {
        const list = $ee0ce775d2fb3caf$export$effcdbd76139450(args, "pubkey_for_exp", 1, "atom");
        const value = (0, $fpZC2$chiabls.mod)(list[0].toBigInt(), (0, $fpZC2$chiabls.defaultEc).n);
        const exponent = (0, $fpZC2$chiabls.PrivateKey).fromBytes((0, $fpZC2$chiabls.bigIntToBytes)(value, 32, "big"));
        const cost = (0, $50d1f9204136c73a$export$5fe13095c61781e4).pubkeyBase + BigInt(list[0].atom.length) * (0, $50d1f9204136c73a$export$5fe13095c61781e4).pubkeyPerByte;
        return $ee0ce775d2fb3caf$export$c85cac6a8d81208f({
          value: (0, $9636c8954d640602$export$b6c59b989905b650).fromBytes(exponent.getG1().toBytes()),
          cost
        });
      },
      point_add: (args) => {
        const list = $ee0ce775d2fb3caf$export$effcdbd76139450(args, "point_add", void 0, "atom");
        let cost = (0, $50d1f9204136c73a$export$5fe13095c61781e4).pointAddBase;
        let point = (0, $fpZC2$chiabls.JacobianPoint).infinityG1();
        for (const item of list) {
          point = point.add((0, $fpZC2$chiabls.JacobianPoint).fromBytes(item.atom, false));
          cost += (0, $50d1f9204136c73a$export$5fe13095c61781e4).pointAddPerArg;
        }
        return $ee0ce775d2fb3caf$export$c85cac6a8d81208f({
          value: (0, $9636c8954d640602$export$b6c59b989905b650).fromBytes(point.toBytes()),
          cost
        });
      },
      strlen: (args) => {
        const list = $ee0ce775d2fb3caf$export$effcdbd76139450(args, "strlen", 1, "atom");
        const size = list[0].atom.length;
        const cost = (0, $50d1f9204136c73a$export$5fe13095c61781e4).strlenBase + BigInt(size) * (0, $50d1f9204136c73a$export$5fe13095c61781e4).strlenPerByte;
        return $ee0ce775d2fb3caf$export$c85cac6a8d81208f({
          value: (0, $9636c8954d640602$export$b6c59b989905b650).fromInt(size),
          cost
        });
      },
      substr: (args) => {
        const list = $ee0ce775d2fb3caf$export$effcdbd76139450(args, "substr", [
          2,
          3
        ], "atom");
        const value = list[0].atom;
        if (list[1].atom.length > 4 || list.length === 3 && list[2].atom.length > 4) throw new Error(`Expected 4 byte indices in "substr" operator${args.positionSuffix}.`);
        const from = list[1].toInt();
        const to = list.length === 3 ? list[2].toInt() : value.length;
        if (to > value.length || to < from || to < 0 || from < 0) throw new Error(`Invalid indices in "substr" operator${args.positionSuffix}.`);
        return {
          value: (0, $9636c8954d640602$export$b6c59b989905b650).fromBytes(value.slice(from, to)),
          cost: 1n
        };
      },
      concat: (args) => {
        const list = $ee0ce775d2fb3caf$export$effcdbd76139450(args, "concat", void 0, "atom");
        let cost = (0, $50d1f9204136c73a$export$5fe13095c61781e4).concatBase;
        const bytes = [];
        for (const item of list) {
          for (const byte of item.atom) bytes.push(byte);
          cost += (0, $50d1f9204136c73a$export$5fe13095c61781e4).concatPerArg;
        }
        cost += BigInt(bytes.length) * (0, $50d1f9204136c73a$export$5fe13095c61781e4).concatPerByte;
        return $ee0ce775d2fb3caf$export$c85cac6a8d81208f({
          value: (0, $9636c8954d640602$export$b6c59b989905b650).fromBytes(Uint8Array.from(bytes)),
          cost
        });
      },
      ash: (args) => {
        const list = $ee0ce775d2fb3caf$export$effcdbd76139450(args, "ash", 2, "atom");
        if (list[1].atom.length > 4) throw new Error(`Shift must be 32 bits in "ash" operator${args.positionSuffix}.`);
        const shift = list[1].toBigInt();
        if ((shift < 0n ? -shift : shift) > 65535n) throw new Error(`Shift too large in "ash" operator${args.positionSuffix}.`);
        let value = list[0].toBigInt();
        if (shift >= 0) value <<= shift;
        else value >>= -shift;
        const cost = (0, $50d1f9204136c73a$export$5fe13095c61781e4).ashiftBase + (BigInt(list[0].atom.length) + BigInt($ee0ce775d2fb3caf$export$2f0301b329918c24(value))) * (0, $50d1f9204136c73a$export$5fe13095c61781e4).ashiftPerByte;
        return $ee0ce775d2fb3caf$export$c85cac6a8d81208f({
          value: (0, $9636c8954d640602$export$b6c59b989905b650).fromBigInt(value),
          cost
        });
      },
      lsh: (args) => {
        const list = $ee0ce775d2fb3caf$export$effcdbd76139450(args, "lsh", 2, "atom");
        if (list[1].atom.length > 4) throw new Error(`Shift must be 32 bits in "lsh" operator${args.positionSuffix}.`);
        const shift = list[1].toBigInt();
        if ((shift < 0n ? -shift : shift) > 65535n) throw new Error(`Shift too large in "lsh" operator${args.positionSuffix}.`);
        let value = (0, $fpZC2$chiabls.bytesToBigInt)(list[0].atom, "big", false);
        if (value < 0n) value = -value;
        if (shift >= 0) value <<= shift;
        else value >>= -shift;
        const cost = (0, $50d1f9204136c73a$export$5fe13095c61781e4).lshiftBase + (BigInt(list[0].atom.length) + BigInt($ee0ce775d2fb3caf$export$2f0301b329918c24(value))) * (0, $50d1f9204136c73a$export$5fe13095c61781e4).lshiftPerByte;
        return $ee0ce775d2fb3caf$export$c85cac6a8d81208f({
          value: (0, $9636c8954d640602$export$b6c59b989905b650).fromBigInt(value),
          cost
        });
      },
      logand: (args) => $ee0ce775d2fb3caf$export$a0a039066bddd5e0("logand", -1n, args, (a, b) => a & b),
      logior: (args) => $ee0ce775d2fb3caf$export$a0a039066bddd5e0("logior", 0n, args, (a, b) => a | b),
      logxor: (args) => $ee0ce775d2fb3caf$export$a0a039066bddd5e0("logxor", 0n, args, (a, b) => a ^ b),
      lognot: (args) => {
        const items = $ee0ce775d2fb3caf$export$effcdbd76139450(args, "lognot", 1, "atom");
        const cost = (0, $50d1f9204136c73a$export$5fe13095c61781e4).lognotBase + BigInt(items[0].atom.length) * (0, $50d1f9204136c73a$export$5fe13095c61781e4).lognotPerByte;
        return $ee0ce775d2fb3caf$export$c85cac6a8d81208f({
          value: (0, $9636c8954d640602$export$b6c59b989905b650).fromBigInt(~items[0].toBigInt()),
          cost
        });
      },
      not: (args) => {
        const items = $ee0ce775d2fb3caf$export$effcdbd76139450(args, "not", 1);
        const cost = (0, $50d1f9204136c73a$export$5fe13095c61781e4).boolBase;
        return {
          value: (0, $9636c8954d640602$export$b6c59b989905b650).fromBool(items[0].isNull),
          cost
        };
      },
      any: (args) => {
        const list = $ee0ce775d2fb3caf$export$effcdbd76139450(args, "any");
        const cost = (0, $50d1f9204136c73a$export$5fe13095c61781e4).boolBase + BigInt(list.length) * (0, $50d1f9204136c73a$export$5fe13095c61781e4).boolPerArg;
        let result = false;
        for (const item of list) if (!item.isNull) {
          result = true;
          break;
        }
        return {
          value: (0, $9636c8954d640602$export$b6c59b989905b650).fromBool(result),
          cost
        };
      },
      all: (args) => {
        const list = $ee0ce775d2fb3caf$export$effcdbd76139450(args, "all");
        const cost = (0, $50d1f9204136c73a$export$5fe13095c61781e4).boolBase + BigInt(list.length) * (0, $50d1f9204136c73a$export$5fe13095c61781e4).boolPerArg;
        let result = true;
        for (const item of list) if (item.isNull) {
          result = false;
          break;
        }
        return {
          value: (0, $9636c8954d640602$export$b6c59b989905b650).fromBool(result),
          cost
        };
      },
      softfork: (args) => {
        const list = $ee0ce775d2fb3caf$export$effcdbd76139450(args, "softfork", [
          1,
          Infinity
        ]);
        if (!list[0].isAtom) throw new Error(`Expected atom argument in "softfork" operator at ${list[0].positionSuffix}.`);
        const cost = list[0].toBigInt();
        if (cost < 1n) throw new Error(`Cost must be greater than zero in "softfork" operator${args.positionSuffix}.`);
        return {
          value: (0, $9636c8954d640602$export$b6c59b989905b650).false,
          cost
        };
      }
    };
    var $ee0ce775d2fb3caf$export$391b7405552d5e99 = {
      operators: $ee0ce775d2fb3caf$export$ccbce4efa7f8029b,
      unknown: $ee0ce775d2fb3caf$export$2d0c81c03591c44,
      quote: "q",
      apply: "a"
    };
    function $ee0ce775d2fb3caf$export$46a92a3441911620() {
      return {
        ...$ee0ce775d2fb3caf$export$391b7405552d5e99,
        operators: {
          ...$ee0ce775d2fb3caf$export$391b7405552d5e99.operators
        }
      };
    }
    function $ee0ce775d2fb3caf$export$effcdbd76139450(program, name, length, type) {
      const list = program.toList();
      if (typeof length === "number" && list.length !== length) throw new Error(`Expected ${length} arguments in ${JSON.stringify(name)} operator${program.positionSuffix}.`);
      else if (Array.isArray(length) && (list.length < length[0] || list.length > length[1])) throw new Error(`Expected ${length[1] === Infinity ? `at least ${length[0]}` : `between ${length[0]} and ${length[1]}`} arguments in ${JSON.stringify(name)} operator${program.positionSuffix}.`);
      if (type !== void 0) list.forEach((item) => {
        if (type === "atom" && !item.isAtom || type === "cons" && !item.isCons) throw new Error(`Expected ${type} argument in ${JSON.stringify(name)} operator${item.positionSuffix}.`);
      });
      return list;
    }
    function $ee0ce775d2fb3caf$export$2f0301b329918c24(value) {
      let length = value === 0n ? 0 : (value < 0n ? -value : value).toString(2).length;
      if (value < 0n) length++;
      return length + 7 >> 3;
    }
    function $ee0ce775d2fb3caf$export$c85cac6a8d81208f(output) {
      return {
        value: output.value,
        cost: output.cost + BigInt(output.value.atom.length) * (0, $50d1f9204136c73a$export$5fe13095c61781e4).mallocPerByte
      };
    }
    function $ee0ce775d2fb3caf$export$a0a039066bddd5e0(opName, initialValue, args, opFunction) {
      let total = initialValue;
      let argSize = 0;
      let cost = (0, $50d1f9204136c73a$export$5fe13095c61781e4).logBase;
      for (const item of args.toList().map((item2) => {
        if (!item2.isAtom) throw new Error(`Expected atom argument in ${JSON.stringify(opName)} operator${item2.positionSuffix}.`);
        return item2;
      })) {
        total = opFunction(total, item.toBigInt());
        argSize += item.atom.length;
        cost += (0, $50d1f9204136c73a$export$5fe13095c61781e4).logPerArg;
      }
      cost += BigInt(argSize) * (0, $50d1f9204136c73a$export$5fe13095c61781e4).logPerByte;
      return $ee0ce775d2fb3caf$export$c85cac6a8d81208f({
        value: (0, $9636c8954d640602$export$b6c59b989905b650).fromBigInt(total),
        cost
      });
    }
    function $ee0ce775d2fb3caf$export$2d0c81c03591c44(op, args) {
      if (!op.atom.length || (0, $fpZC2$chiabls.bytesEqual)(op.atom.slice(0, 2), Uint8Array.from([
        255,
        255
      ]))) throw new Error(`Reserved operator${op.positionSuffix}.`);
      if (op.atom.length > 5) throw new Error(`Invalid operator${op.positionSuffix}.`);
      const costFunction = (op.atom[op.atom.length - 1] & 192) >> 6;
      const costMultiplier = (0, $fpZC2$chiabls.bytesToInt)(op.atom.slice(0, op.atom.length - 1), "big") + 1;
      let cost;
      if (costFunction === 0) cost = 1n;
      else if (costFunction === 1) {
        cost = (0, $50d1f9204136c73a$export$5fe13095c61781e4).arithBase;
        let argSize = 0;
        for (const item of args.toList()) {
          if (!item.isAtom) throw new Error(`Expected atom argument${item.positionSuffix}.`);
          argSize += item.atom.length;
          cost += (0, $50d1f9204136c73a$export$5fe13095c61781e4).arithPerArg;
        }
        cost += BigInt(argSize) * (0, $50d1f9204136c73a$export$5fe13095c61781e4).arithPerByte;
      } else if (costFunction === 2) {
        cost = (0, $50d1f9204136c73a$export$5fe13095c61781e4).mulBase;
        const argList = args.toList();
        if (argList.length) {
          const first = argList[0];
          if (!first.isAtom) throw new Error(`Expected atom argument${first.positionSuffix}.`);
          let current = first.atom.length;
          for (const item of argList.slice(1)) {
            if (!item.isAtom) throw new Error(`Expected atom argument${item.positionSuffix}.`);
            cost += (0, $50d1f9204136c73a$export$5fe13095c61781e4).mulPerOp + (BigInt(item.atom.length) + BigInt(current)) * (0, $50d1f9204136c73a$export$5fe13095c61781e4).mulLinearPerByte + BigInt(item.atom.length) * BigInt(current) / (0, $50d1f9204136c73a$export$5fe13095c61781e4).mulSquarePerByteDivider;
            current += item.atom.length;
          }
        }
      } else if (costFunction === 3) {
        cost = (0, $50d1f9204136c73a$export$5fe13095c61781e4).concatBase;
        let length = 0;
        for (const item of args.toList()) {
          if (!item.isAtom) throw new Error(`Expected atom argument${item.positionSuffix}.`);
          cost += (0, $50d1f9204136c73a$export$5fe13095c61781e4).concatPerArg;
          length += item.atom.length;
        }
        cost += BigInt(length) * (0, $50d1f9204136c73a$export$5fe13095c61781e4).concatPerByte;
      } else throw new Error(`Unknown cost function${op.positionSuffix}.`);
      cost *= BigInt(costMultiplier);
      if (cost >= 2n ** 32n) throw new Error(`Invalid operator${op.positionSuffix}.`);
      return {
        value: (0, $9636c8954d640602$export$b6c59b989905b650).nil,
        cost
      };
    }
    function $ee0ce775d2fb3caf$export$664a4a7902029a5b(op, args, options) {
      const symbol = op.toBigInt();
      const keyword = Object.entries((0, $94ca46fd7d128ba2$export$eebaaf2b24d91f63)).find((entry) => entry[1] === symbol)?.[0] ?? op.toText();
      if (keyword in options.operators.operators) {
        const result = options.operators.operators[keyword](args);
        return result;
      } else return options.operators.unknown(op, args);
    }
    var $bd56f675ad0fd6d4$export$21ba78b50397401d = {
      swap: (_instructionStack, stack, _options) => {
        const second = stack.pop();
        const first = stack.pop();
        stack.push(second, first);
        return 0n;
      },
      cons: (_instructionStack, stack, _options) => {
        const first = stack.pop();
        const second = stack.pop();
        stack.push((0, $9636c8954d640602$export$b6c59b989905b650).cons(first, second));
        return 0n;
      },
      eval: (instructionStack, stack, _options) => {
        const pair = stack.pop();
        const program = pair.first;
        const args = pair.rest;
        if (program.isAtom) {
          const output = (0, $b45cfe84191f72e9$export$520469ab96a2a022)(program, args);
          stack.push(output.value);
          return output.cost;
        }
        const op = program.first;
        if (op.isCons) {
          const [newOperator, mustBeNil] = op.cons;
          if (newOperator.isCons || !mustBeNil.isNull) throw new Error(`Operators that are lists must contain a single atom${op.positionSuffix}.`);
          const newOperandList = program.rest;
          stack.push(newOperator, newOperandList);
          instructionStack.push($bd56f675ad0fd6d4$export$21ba78b50397401d.apply);
          return (0, $50d1f9204136c73a$export$5fe13095c61781e4).apply;
        }
        let operandList = program.rest;
        if ((0, $fpZC2$chiabls.bytesEqual)(op.atom, (0, $69b3f00f8a7733d7$export$2ede34752a982e57))) {
          stack.push(operandList);
          return (0, $50d1f9204136c73a$export$5fe13095c61781e4).quote;
        }
        instructionStack.push($bd56f675ad0fd6d4$export$21ba78b50397401d.apply);
        stack.push(op);
        while (!operandList.isNull) {
          stack.push((0, $9636c8954d640602$export$b6c59b989905b650).cons(operandList.first, args));
          instructionStack.push($bd56f675ad0fd6d4$export$21ba78b50397401d.cons, $bd56f675ad0fd6d4$export$21ba78b50397401d.eval, $bd56f675ad0fd6d4$export$21ba78b50397401d.swap);
          operandList = operandList.rest;
        }
        stack.push((0, $9636c8954d640602$export$b6c59b989905b650).nil);
        return 1n;
      },
      apply: (instructionStack, stack, options) => {
        const operandList = stack.pop();
        const op = stack.pop();
        if (op.isCons) throw new Error(`An internal error occurred${op.positionSuffix}.`);
        if ((0, $fpZC2$chiabls.bytesEqual)(op.atom, (0, $69b3f00f8a7733d7$export$688e2fe60354a4fd))) {
          const args = operandList.toList();
          if (args.length !== 2) throw new Error(`Expected 2 arguments in "a" operator${operandList.positionSuffix}.`);
          stack.push((0, $9636c8954d640602$export$b6c59b989905b650).cons(args[0], args[1]));
          instructionStack.push($bd56f675ad0fd6d4$export$21ba78b50397401d.eval);
          return (0, $50d1f9204136c73a$export$5fe13095c61781e4).apply;
        }
        const output = (0, $ee0ce775d2fb3caf$export$664a4a7902029a5b)(op, operandList, options);
        stack.push(output.value);
        return output.cost;
      }
    };
    function $ecfc887e9c4d9ec4$export$efcd34ab6248d3cd(program) {
      const sizeBytes = [];
      if (program[0] <= 127) return (0, $9636c8954d640602$export$b6c59b989905b650).fromBytes(Uint8Array.from([
        program[0]
      ]));
      else if (program[0] <= 191) sizeBytes.push(program[0] & 63);
      else if (program[0] <= 223) {
        sizeBytes.push(program[0] & 31);
        program.shift();
        if (!program.length) throw new (0, $a550084cece3e4e0$export$d125cf0331bff9a9)("Expected next byte in source.");
        sizeBytes.push(program[0]);
      } else if (program[0] <= 239) {
        sizeBytes.push(program[0] & 15);
        for (let i = 0; i < 2; i++) {
          program.shift();
          if (!program.length) throw new (0, $a550084cece3e4e0$export$d125cf0331bff9a9)("Expected next byte in source.");
          sizeBytes.push(program[0]);
        }
      } else if (program[0] <= 247) {
        sizeBytes.push(program[0] & 7);
        for (let i = 0; i < 3; i++) {
          program.shift();
          if (!program.length) throw new (0, $a550084cece3e4e0$export$d125cf0331bff9a9)("Expected next byte in source.");
          sizeBytes.push(program[0]);
        }
      } else if (program[0] <= 251) {
        sizeBytes.push(program[0] & 3);
        for (let i = 0; i < 4; i++) {
          program.shift();
          if (!program.length) throw new (0, $a550084cece3e4e0$export$d125cf0331bff9a9)("Expected next byte in source.");
          sizeBytes.push(program[0]);
        }
      } else if (program[0] === 255) {
        program.shift();
        if (!program.length) throw new (0, $a550084cece3e4e0$export$d125cf0331bff9a9)("Expected next byte in source.");
        const first = $ecfc887e9c4d9ec4$export$efcd34ab6248d3cd(program);
        program.shift();
        if (!program.length) throw new (0, $a550084cece3e4e0$export$d125cf0331bff9a9)("Expected next byte in source.");
        const rest = $ecfc887e9c4d9ec4$export$efcd34ab6248d3cd(program);
        return (0, $9636c8954d640602$export$b6c59b989905b650).cons(first, rest);
      } else throw new (0, $a550084cece3e4e0$export$d125cf0331bff9a9)("Invalid encoding.");
      const size = (0, $fpZC2$chiabls.decodeInt)(Uint8Array.from(sizeBytes));
      let bytes = [];
      for (let i = 0; i < size; i++) {
        program.shift();
        if (!program.length) throw new (0, $a550084cece3e4e0$export$d125cf0331bff9a9)("Expected next byte in atom.");
        bytes.push(program[0]);
      }
      return (0, $9636c8954d640602$export$b6c59b989905b650).fromBytes(Uint8Array.from(bytes));
    }
    var $2795eb571c1ed5e7$export$13807d9ee5a34a42 = class {
      line;
      column;
      constructor(source, index) {
        source = source.replaceAll("\r\n", "\n");
        let line = 1;
        let column = 1;
        for (let i = 0; i < index; i++) if (source[i] === "\n") {
          line++;
          column = 1;
        } else column++;
        this.line = line;
        this.column = column;
      }
      toString() {
        return `${this.line}:${this.column}`;
      }
    };
    function $bdb42fba8f5f461a$export$48cfd1e771a65c4f(tokens) {
      tokens.shift();
      return tokens[0];
    }
    function $bdb42fba8f5f461a$export$3570f33b1a1f3329(source, tokens) {
      const token = tokens[0];
      if (!$bdb42fba8f5f461a$export$48cfd1e771a65c4f(tokens)) throw new (0, $a550084cece3e4e0$export$d125cf0331bff9a9)(`Unexpected end of source at ${new (0, $2795eb571c1ed5e7$export$13807d9ee5a34a42)(source, token.index)}.`);
    }
    function $bdb42fba8f5f461a$export$1d5ccafae59b4926(char) {
      return /^[\u0020\u202F\u205F\u2028\u2029\u3000\u0085\u1680\u00A0\u2000-\u200A\u0009-\u000D\u001C-\u001F]$/.test(char);
    }
    function $bdb42fba8f5f461a$export$ab7f5d67832a6850(text, index) {
      while (true) {
        while (index < text.length && $bdb42fba8f5f461a$export$1d5ccafae59b4926(text[index])) index++;
        if (index >= text.length || text[index] !== ";") break;
        while (index < text.length && !"\n\r".includes(text[index])) index++;
      }
      return index;
    }
    function $bdb42fba8f5f461a$export$92d34793dd37ac50(text, index) {
      const start = index;
      while (index < text.length && !$bdb42fba8f5f461a$export$1d5ccafae59b4926(text[index]) && text[index] !== ")") index++;
      return {
        text: text.slice(start, index),
        index
      };
    }
    function $bdb42fba8f5f461a$export$4e9e188b3a3b0cbf(source, tokens) {
      let token = tokens[0];
      if (token.text === ")") return (0, $9636c8954d640602$export$b6c59b989905b650).fromBytes(Uint8Array.from([])).at(new (0, $2795eb571c1ed5e7$export$13807d9ee5a34a42)(source, token.index));
      const consStart = token.index;
      const first = $bdb42fba8f5f461a$export$cd60724007a613c1(source, tokens);
      $bdb42fba8f5f461a$export$3570f33b1a1f3329(source, tokens);
      token = tokens[0];
      let rest;
      if (token.text === ".") {
        const dotStart = token.index;
        $bdb42fba8f5f461a$export$3570f33b1a1f3329(source, tokens);
        token = tokens[0];
        rest = $bdb42fba8f5f461a$export$cd60724007a613c1(source, tokens);
        $bdb42fba8f5f461a$export$3570f33b1a1f3329(source, tokens);
        token = tokens[0];
        if (token.text !== ")") throw new (0, $a550084cece3e4e0$export$d125cf0331bff9a9)(`Illegal dot expression at ${new (0, $2795eb571c1ed5e7$export$13807d9ee5a34a42)(source, dotStart)}.`);
      } else rest = $bdb42fba8f5f461a$export$4e9e188b3a3b0cbf(source, tokens);
      return (0, $9636c8954d640602$export$b6c59b989905b650).cons(first, rest).at(new (0, $2795eb571c1ed5e7$export$13807d9ee5a34a42)(source, consStart));
    }
    function $bdb42fba8f5f461a$export$cbe5a625b098a663(source, token) {
      return /^[+\-]?[0-9]+(?:_[0-9]+)*$/.test(token.text) ? (0, $9636c8954d640602$export$b6c59b989905b650).fromBigInt(BigInt(token.text.replaceAll("_", ""))).at(new (0, $2795eb571c1ed5e7$export$13807d9ee5a34a42)(source, token.index)) : null;
    }
    function $bdb42fba8f5f461a$export$c553c4a3641f57a2(source, token) {
      if (token.text.length >= 2 && token.text.slice(0, 2).toLowerCase() === "0x") {
        let hex = token.text.slice(2);
        if (hex.length % 2 === 1) hex = `0${hex}`;
        try {
          return (0, $9636c8954d640602$export$b6c59b989905b650).fromHex(hex).at(new (0, $2795eb571c1ed5e7$export$13807d9ee5a34a42)(source, token.index));
        } catch (e) {
          throw new (0, $a550084cece3e4e0$export$d125cf0331bff9a9)(`Invalid hex ${JSON.stringify(token.text)} at ${new (0, $2795eb571c1ed5e7$export$13807d9ee5a34a42)(source, token.index)}.`);
        }
      } else return null;
    }
    function $bdb42fba8f5f461a$export$efc939cd3ec83299(source, token) {
      if (token.text.length < 2) return null;
      const quote = token.text[0];
      if (!`"'`.includes(quote)) return null;
      if (token.text[token.text.length - 1] !== quote) throw new (0, $a550084cece3e4e0$export$d125cf0331bff9a9)(`Unterminated string ${JSON.stringify(token.text)} at ${new (0, $2795eb571c1ed5e7$export$13807d9ee5a34a42)(source, token.index)}.`);
      return (0, $9636c8954d640602$export$b6c59b989905b650).fromText(token.text.slice(1, token.text.length - 1)).at(new (0, $2795eb571c1ed5e7$export$13807d9ee5a34a42)(source, token.index));
    }
    function $bdb42fba8f5f461a$export$52faefa73a5cb81b(source, token) {
      let text = token.text;
      if (text.startsWith("#")) text = text.slice(1);
      const keyword = (0, $94ca46fd7d128ba2$export$eebaaf2b24d91f63)[text];
      return (keyword === void 0 ? (0, $9636c8954d640602$export$b6c59b989905b650).fromText(text) : (0, $9636c8954d640602$export$b6c59b989905b650).fromBigInt(keyword)).at(new (0, $2795eb571c1ed5e7$export$13807d9ee5a34a42)(source, token.index));
    }
    function $bdb42fba8f5f461a$export$cd60724007a613c1(source, tokens) {
      const token = tokens[0];
      if (token.text === "(") {
        $bdb42fba8f5f461a$export$3570f33b1a1f3329(source, tokens);
        return $bdb42fba8f5f461a$export$4e9e188b3a3b0cbf(source, tokens);
      }
      const result = $bdb42fba8f5f461a$export$cbe5a625b098a663(source, token) ?? $bdb42fba8f5f461a$export$c553c4a3641f57a2(source, token) ?? $bdb42fba8f5f461a$export$efc939cd3ec83299(source, token) ?? $bdb42fba8f5f461a$export$52faefa73a5cb81b(source, token);
      if (!result) throw new (0, $a550084cece3e4e0$export$d125cf0331bff9a9)(`Invalid expression ${JSON.stringify(token.text)} at ${new (0, $2795eb571c1ed5e7$export$13807d9ee5a34a42)(source, token.index)}.`);
      return result;
    }
    function* $bdb42fba8f5f461a$export$f3f15647e54e234d(source) {
      let index = 0;
      while (index < source.length) {
        index = $bdb42fba8f5f461a$export$ab7f5d67832a6850(source, index);
        if (index >= source.length) break;
        const char = source[index];
        if ("(.)".includes(char)) {
          yield {
            text: char,
            index
          };
          index++;
          continue;
        }
        if (`"'`.includes(char)) {
          const start = index;
          const quote = source[index];
          index++;
          while (index < source.length && source[index] !== quote) index++;
          if (index < source.length) {
            yield {
              text: source.slice(start, index + 1),
              index: start
            };
            index++;
            continue;
          } else throw new (0, $a550084cece3e4e0$export$d125cf0331bff9a9)(`Unterminated string at ${new (0, $2795eb571c1ed5e7$export$13807d9ee5a34a42)(source, index)}.`);
        }
        const token = $bdb42fba8f5f461a$export$92d34793dd37ac50(source, index);
        yield {
          text: token.text,
          index
        };
        index = token.index;
      }
    }
    var $9636c8954d640602$export$b6c59b989905b650 = class _$9636c8954d640602$export$b6c59b989905b650 {
      static cost = 11e9;
      static true = _$9636c8954d640602$export$b6c59b989905b650.fromBytes(Uint8Array.from([
        1
      ]));
      static false = _$9636c8954d640602$export$b6c59b989905b650.fromBytes(Uint8Array.from([]));
      static nil = _$9636c8954d640602$export$b6c59b989905b650.false;
      value;
      position;
      get atom() {
        if (!this.isAtom) throw new Error(`Expected atom${this.positionSuffix}.`);
        return this.value;
      }
      get cons() {
        if (!this.isCons) throw new Error(`Expected cons${this.positionSuffix}.`);
        return this.value;
      }
      get first() {
        return this.cons[0];
      }
      get rest() {
        return this.cons[1];
      }
      get isAtom() {
        return this.value instanceof Uint8Array;
      }
      get isCons() {
        return Array.isArray(this.value);
      }
      get isNull() {
        return this.isAtom && this.value.length === 0;
      }
      static cons(first, rest) {
        return new _$9636c8954d640602$export$b6c59b989905b650([
          first,
          rest
        ]);
      }
      static fromBytes(bytes) {
        return new _$9636c8954d640602$export$b6c59b989905b650(bytes);
      }
      static fromJacobianPoint(jacobianPoint) {
        return new _$9636c8954d640602$export$b6c59b989905b650(jacobianPoint.toBytes());
      }
      static fromPrivateKey(privateKey) {
        return new _$9636c8954d640602$export$b6c59b989905b650(privateKey.toBytes());
      }
      static fromHex(hex) {
        return new _$9636c8954d640602$export$b6c59b989905b650((0, $fpZC2$chiabls.fromHex)(hex));
      }
      static fromBool(value) {
        return value ? _$9636c8954d640602$export$b6c59b989905b650.true : _$9636c8954d640602$export$b6c59b989905b650.false;
      }
      static fromInt(value) {
        return new _$9636c8954d640602$export$b6c59b989905b650((0, $fpZC2$chiabls.encodeInt)(value));
      }
      static fromBigInt(value) {
        return new _$9636c8954d640602$export$b6c59b989905b650((0, $fpZC2$chiabls.encodeBigInt)(value));
      }
      static fromText(text) {
        return new _$9636c8954d640602$export$b6c59b989905b650(new TextEncoder().encode(text));
      }
      static fromSource(source) {
        const stream = (0, $bdb42fba8f5f461a$export$f3f15647e54e234d)(source);
        const tokens = [
          ...stream
        ];
        if (tokens.length) return (0, $bdb42fba8f5f461a$export$cd60724007a613c1)(source, tokens);
        else throw new (0, $a550084cece3e4e0$export$d125cf0331bff9a9)("Unexpected end of source.");
      }
      static fromList(programs) {
        let result = _$9636c8954d640602$export$b6c59b989905b650.nil;
        for (const program of programs.reverse()) result = _$9636c8954d640602$export$b6c59b989905b650.cons(program, result);
        return result;
      }
      static deserialize(bytes) {
        const program = [
          ...bytes
        ];
        if (!program.length) throw new (0, $a550084cece3e4e0$export$d125cf0331bff9a9)("Unexpected end of source.");
        return (0, $ecfc887e9c4d9ec4$export$efcd34ab6248d3cd)(program);
      }
      static deserializeHex(hex) {
        return _$9636c8954d640602$export$b6c59b989905b650.deserialize((0, $fpZC2$chiabls.fromHex)(hex));
      }
      constructor(value) {
        this.value = value;
      }
      get positionSuffix() {
        return this.position ? ` at ${this.position}` : "";
      }
      at(position) {
        this.position = position;
        return this;
      }
      curry(args) {
        return _$9636c8954d640602$export$b6c59b989905b650.fromSource("(a (q #a 4 (c 2 (c 5 (c 7 0)))) (c (q (c (q . 2) (c (c (q . 1) 5) (c (a 6 (c 2 (c 11 (q 1)))) 0))) #a (i 5 (q 4 (q . 4) (c (c (q . 1) 9) (c (a 6 (c 2 (c 13 (c 11 0)))) 0))) (q . 11)) 1) 1))").run(_$9636c8954d640602$export$b6c59b989905b650.cons(this, _$9636c8954d640602$export$b6c59b989905b650.fromList(args))).value;
      }
      uncurry() {
        const uncurryPatternFunction = _$9636c8954d640602$export$b6c59b989905b650.fromSource("(a (q . (: . function)) (: . core))");
        const uncurryPatternCore = _$9636c8954d640602$export$b6c59b989905b650.fromSource("(c (q . (: . parm)) (: . core))");
        let result = (0, $b28f999d37dccebe$export$4659b591c19bdf3d)(uncurryPatternFunction, this);
        if (!result) return null;
        const fn = result.function;
        let core = result.core;
        const args = [];
        while (true) {
          result = (0, $b28f999d37dccebe$export$4659b591c19bdf3d)(uncurryPatternCore, core);
          if (!result) break;
          args.push(result.parm);
          core = result.core;
        }
        if (core.isAtom && core.toBigInt() === 1n) return [
          fn,
          args
        ];
        return null;
      }
      hash() {
        return this.isAtom ? (0, $fpZC2$chiabls.hash256)((0, $fpZC2$chiabls.concatBytes)(Uint8Array.from([
          1
        ]), this.atom)) : (0, $fpZC2$chiabls.hash256)((0, $fpZC2$chiabls.concatBytes)(Uint8Array.from([
          2
        ]), this.first.hash(), this.rest.hash()));
      }
      hashHex() {
        return (0, $fpZC2$chiabls.toHex)(this.hash());
      }
      define(program) {
        let result = this;
        if (this.isAtom || this.first.isCons || this.first.toText() !== "mod") result = _$9636c8954d640602$export$b6c59b989905b650.fromList([
          _$9636c8954d640602$export$b6c59b989905b650.fromText("mod"),
          _$9636c8954d640602$export$b6c59b989905b650.nil,
          this
        ]);
        const items = result.toList();
        items.splice(2, 0, program);
        return _$9636c8954d640602$export$b6c59b989905b650.fromList(items);
      }
      defineAll(programs) {
        let result = this;
        for (const program of programs.reverse()) result = result.define(program);
        return result;
      }
      compile(options = {}) {
        const fullOptions = {
          strict: false,
          operators: (0, $ee0ce775d2fb3caf$export$46a92a3441911620)(),
          includeFilePaths: {},
          ...options
        };
        if (fullOptions.strict) fullOptions.operators.unknown = (_operator, args) => {
          throw new Error(`Unimplemented operator${args.positionSuffix}.`);
        };
        function doFullPathForName(args) {
          const fileName = args.first.toText();
          for (const [path, files] of Object.entries(fullOptions.includeFilePaths)) {
            if (fileName in files) return {
              value: _$9636c8954d640602$export$b6c59b989905b650.fromText(`${path}/${fileName}`),
              cost: 1n
            };
          }
          throw new Error(`Can't open ${fileName}${args.positionSuffix}.`);
        }
        function doRead(args) {
          const fileName = args.first.toText();
          let source = null;
          for (const [path, files] of Object.entries(fullOptions.includeFilePaths)) {
            for (const [file, content] of Object.entries(files)) if (fileName === `${path}/${file}`) source = content;
          }
          if (source === null) throw new Error(`Can't open ${fileName}${args.positionSuffix}.`);
          return {
            value: _$9636c8954d640602$export$b6c59b989905b650.fromSource(source),
            cost: 1n
          };
        }
        function doWrite(_args) {
          return {
            value: _$9636c8954d640602$export$b6c59b989905b650.nil,
            cost: 1n
          };
        }
        function runProgram(program, args) {
          return program.run(args, fullOptions);
        }
        const bindings = {
          com: (0, $6edfc72fb8768007$export$5af009c3dc40b1bc)(runProgram),
          opt: (0, $a985f73a592474fb$export$f47d6a487cee0a73)(runProgram),
          _full_path_for_name: doFullPathForName,
          _read: doRead,
          _write: doWrite
        };
        Object.assign(fullOptions.operators.operators, bindings);
        return runProgram(_$9636c8954d640602$export$b6c59b989905b650.fromSource("(a (opt (com 2)) 3)"), _$9636c8954d640602$export$b6c59b989905b650.fromList([
          this
        ]));
      }
      run(environment, options = {}) {
        const fullOptions = {
          strict: false,
          operators: (0, $ee0ce775d2fb3caf$export$46a92a3441911620)(),
          ...options
        };
        if (fullOptions.strict) fullOptions.operators.unknown = (_operator, args) => {
          throw new Error(`Unimplemented operator${args.positionSuffix}.`);
        };
        const instructionStack = [
          (0, $bd56f675ad0fd6d4$export$21ba78b50397401d).eval
        ];
        const stack = [
          _$9636c8954d640602$export$b6c59b989905b650.cons(this, environment)
        ];
        let cost = 0n;
        while (instructionStack.length) {
          const instruction = instructionStack.pop();
          cost += instruction(instructionStack, stack, fullOptions);
          if (fullOptions.maxCost !== void 0 && cost > fullOptions.maxCost) throw new Error(`Exceeded cost of ${fullOptions.maxCost}${stack[stack.length - 1].positionSuffix}.`);
        }
        return {
          value: stack[stack.length - 1],
          cost
        };
      }
      toBytes() {
        if (this.isCons) throw new Error(`Cannot convert ${this.toString()} to hex${this.positionSuffix}.`);
        return this.atom;
      }
      toJacobianPoint() {
        if (this.isCons || this.atom.length !== 48 && this.atom.length !== 96) throw new Error(`Cannot convert ${this.toString()} to JacobianPoint${this.positionSuffix}.`);
        return this.atom.length === 48 ? (0, $fpZC2$chiabls.JacobianPoint).fromBytesG1(this.atom) : (0, $fpZC2$chiabls.JacobianPoint).fromBytesG2(this.atom);
      }
      toPrivateKey() {
        if (this.isCons) throw new Error(`Cannot convert ${this.toString()} to private key${this.positionSuffix}.`);
        return (0, $fpZC2$chiabls.PrivateKey).fromBytes(this.atom);
      }
      toHex() {
        if (this.isCons) throw new Error(`Cannot convert ${this.toString()} to hex${this.positionSuffix}.`);
        return (0, $fpZC2$chiabls.toHex)(this.atom);
      }
      toBool() {
        if (this.isCons) throw new Error(`Cannot convert ${this.toString()} to bool${this.positionSuffix}.`);
        return !this.isNull;
      }
      toInt() {
        if (this.isCons) throw new Error(`Cannot convert ${this.toString()} to int${this.positionSuffix}.`);
        return (0, $fpZC2$chiabls.decodeInt)(this.atom);
      }
      toBigInt() {
        if (this.isCons) throw new Error(`Cannot convert ${this.toString()} to bigint${this.positionSuffix}.`);
        return (0, $fpZC2$chiabls.decodeBigInt)(this.atom);
      }
      toText() {
        if (this.isCons) throw new Error(`Cannot convert ${this.toString()} to text${this.positionSuffix}.`);
        return new TextDecoder().decode(this.atom);
      }
      toSource(showKeywords = true) {
        if (this.isAtom) {
          if (this.isNull) return "()";
          else if (this.value.length > 2) try {
            const string = this.toText();
            for (let i = 0; i < string.length; i++) {
              if (!(0, $1382d0708deed0de$export$b81a09a7187d4786).includes(string[i])) return `0x${this.toHex()}`;
            }
            if (string.includes('"') && string.includes("'")) return `0x${this.toHex()}`;
            const quote = string.includes('"') ? "'" : '"';
            return quote + string + quote;
          } catch {
            return `0x${this.toHex()}`;
          }
          else if ((0, $fpZC2$chiabls.bytesEqual)((0, $fpZC2$chiabls.encodeInt)((0, $fpZC2$chiabls.decodeInt)(this.atom)), this.atom)) return (0, $fpZC2$chiabls.decodeInt)(this.atom).toString();
          else return `0x${this.toHex()}`;
        } else {
          let result = "(";
          if (showKeywords && this.first.isAtom) {
            const value = this.first.toBigInt();
            const keyword = Object.keys((0, $94ca46fd7d128ba2$export$eebaaf2b24d91f63)).find((keyword2) => (0, $94ca46fd7d128ba2$export$eebaaf2b24d91f63)[keyword2] === value);
            result += keyword ? keyword : this.first.toSource(showKeywords);
          } else result += this.first.toSource(showKeywords);
          let current = this.cons[1];
          while (current.isCons) {
            result += ` ${current.first.toSource(showKeywords)}`;
            current = current.cons[1];
          }
          result += (current.isNull ? "" : ` . ${current.toSource(showKeywords)}`) + ")";
          return result;
        }
      }
      toList(strict = false) {
        const result = [];
        let current = this;
        while (current.isCons) {
          const item = current.first;
          result.push(item);
          current = current.rest;
        }
        if (!current.isNull && strict) throw new Error(`Expected strict list${this.positionSuffix}.`);
        return result;
      }
      serialize() {
        if (this.isAtom) {
          if (this.isNull) return Uint8Array.from([
            128
          ]);
          else if (this.atom.length === 1 && this.atom[0] <= 127) return this.atom;
          else {
            const size = this.atom.length;
            const result = [];
            if (size < 64) result.push(128 | size);
            else if (size < 8192) {
              result.push(192 | size >> 8);
              result.push(size >> 0 & 255);
            } else if (size < 1048576) {
              result.push(224 | size >> 16);
              result.push(size >> 8 & 255);
              result.push(size >> 0 & 255);
            } else if (size < 134217728) {
              result.push(240 | size >> 24);
              result.push(size >> 16 & 255);
              result.push(size >> 8 & 255);
              result.push(size >> 0 & 255);
            } else if (size < 17179869184) {
              result.push(248 | size >> 32);
              result.push(size >> 24 & 255);
              result.push(size >> 16 & 255);
              result.push(size >> 8 & 255);
              result.push(size >> 0 & 255);
            } else throw new RangeError(`Cannot serialize ${this.toString()} as it is 17,179,869,184 or more bytes in size${this.positionSuffix}.`);
            for (const byte of this.atom) result.push(byte);
            return Uint8Array.from(result);
          }
        } else {
          const result = [
            255
          ];
          for (const byte of this.first.serialize()) result.push(byte);
          for (const byte of this.rest.serialize()) result.push(byte);
          return Uint8Array.from(result);
        }
      }
      serializeHex() {
        return (0, $fpZC2$chiabls.toHex)(this.serialize());
      }
      equals(value) {
        return this.isAtom === value.isAtom && (this.isAtom ? (0, $fpZC2$chiabls.bytesEqual)(this.atom, value.atom) : this.first.equals(value.first) && this.rest.equals(value.rest));
      }
      toString() {
        return this.toSource();
      }
    };
    $parcel$exportWildcard(module.exports, $a550084cece3e4e0$exports);
  }
});

// ../games/host/index.ts
var ALL_OUTCOMES = /* @__PURE__ */ new Set([
  "accept_settlement",
  "settled_cleanly",
  "opponent_timed_out",
  "forfeited_skipped_reveal",
  "lost",
  "forfeited_we_accepted",
  "we_accepted",
  "attempt_to_move_failed",
  "timed_out_waiting_for_our_move",
  "slashed_opponent",
  "opponent_slashed_us",
  "opponent_cheated"
]);
function isSettlementOutcome(value) {
  return typeof value === "string" && ALL_OUTCOMES.has(value);
}
function requireLiveGameMount(view) {
  if (view.frozen) {
    throw new Error("Protocol commands require a live game mount");
  }
  return view;
}

export {
  __esm,
  __commonJS,
  __export,
  __reExport,
  __toESM,
  __toCommonJS,
  require_react,
  isSettlementOutcome,
  requireLiveGameMount,
  require_jsx_runtime,
  require_src2 as require_src
};
/*! Bundled license information:

react/cjs/react.development.js:
  (**
   * @license React
   * react.development.js
   *
   * Copyright (c) Meta Platforms, Inc. and affiliates.
   *
   * This source code is licensed under the MIT license found in the
   * LICENSE file in the root directory of this source tree.
   *)

react/cjs/react-jsx-runtime.development.js:
  (**
   * @license React
   * react-jsx-runtime.development.js
   *
   * Copyright (c) Meta Platforms, Inc. and affiliates.
   *
   * This source code is licensed under the MIT license found in the
   * LICENSE file in the root directory of this source tree.
   *)
*/
