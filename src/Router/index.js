/*
 * If not stated otherwise in this file or this component's LICENSE file the
 * following copyright and licenses apply:
 *
 * Copyright 2020 RDK Management
 *
 * Licensed under the Apache License, Version 2.0 (the License);
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  isFunction,
  isPage,
  isLightningComponent,
  isArray,
  ucfirst,
  isObject,
  isBoolean,
  isString,
  getConfigMap,
  incorrectParams,
  isPromise,
  getQueryStringParams,
} from './utils'

import Transitions from './transitions'
import Log from '../Log'
import { AppInstance } from '../Launch'
import { RoutedApp } from './base'

let getHash = () => {
  return document.location.hash
}

let setHash = url => {
  document.location.hash = url
}

export const initRouter = config => {
  if (config.getHash) {
    getHash = config.getHash
  }
  if (config.setHash) {
    setHash = config.setHash
  }
}

/*
rouThor ==[x]
 */

// instance of Lightning.Application
let application

//instance of Lightning.Component
let app

let stage
let widgetsHost
let pagesHost

const pages = new Map()
const providers = new Map()
const modifiers = new Map()
const widgetsPerRoute = new Map()

let register = new Map()
let routerConfig

// widget that has focus
let activeWidget
let rootHash
let bootRequest
let history = []
let initialised = false
let activeRoute
let activeHash
let updateHash = true
let forcedHash

// page that has focus
let activePage
const hasRegex = /\{\/(.*?)\/([igm]{0,3})\}/g

/**
 * Setup Page router
 * @param config - route config object
 * @param instance - instance of the app
 */
export const startRouter = (config, instance) => {
  // backwards compatible
  let { appInstance, routes, provider = () => {}, widgets = () => {} } = config

  if (instance && isPage(instance)) {
    app = instance
  }

  if (!app) {
    app = appInstance || AppInstance
  }

  application = app.application
  pagesHost = application.childList
  stage = app.stage
  routerConfig = getConfigMap()

  // test if required to host pages in a different child
  if (app.pages) {
    pagesHost = app.pages.childList
  }

  // test if app uses widgets
  if (app.widgets && app.widgets.children) {
    widgetsHost = app.widgets.childList
  }

  // register step back handler
  app._handleBack = step.bind(null, -1)

  // register step back handler
  app._captureKey = capture.bind(null)

  if (isArray(routes)) {
    setupRoutes(config)
    start()
  } else if (isFunction(routes)) {
    // register route data bindings
    provider()
    // register routes
    routes()
    // register widgets
    widgets()
  }
}

const setupRoutes = routesConfig => {
  let bootPage = routesConfig.bootComponent

  if (!initialised) {
    rootHash = routesConfig.root
    if (isFunction(routesConfig.boot)) {
      boot(routesConfig.boot)
    }
    if (bootPage && isPage(bootPage)) {
      route('@boot-page', routesConfig.bootComponent)
    }
    if (isBoolean(routesConfig.updateHash)) {
      updateHash = routesConfig.updateHash
    }
    initialised = true
  }

  routesConfig.routes.forEach(r => {
    let routeComponent = r.component;

    if (r.async) {
      if (isLightningComponent(routeComponent)) {
        throw new Error("Error registering async route with path '" + r.path + "'. Component property in async routes must be an async factory in the form of () => Promise")
      }

      routeComponent = {
        async: true,
        loader: r.component,
      }
    }

    route(r.path, routeComponent || r.hook, r.options);

    if (r.widgets) {
      widget(r.path, r.widgets)
    }

    if (isFunction(r.on)) {
      on(r.path, r.on, r.cache || 0)
    }
    if (isFunction(r.before)) {
      before(r.path, r.before, r.cache || 0)
    }
    if (isFunction(r.after)) {
      after(r.path, r.after, r.cache || 0)
    }
  })
}

/**
 * create a new route
 * @param route - {string}
 * @param type - {(Lightning.Component|Function()*)}
 * @param modifiers - {Object{}} - preventStorage | clearHistory | storeLast
 */
export const route = (route, type, config) => {
  route = route.replace(/\/+$/, '')
  // if the route is defined we try to push
  // the new type on to the stack
  if (pages.has(route)) {
    let stack = pages.get(route)
    if (!isArray(stack)) {
      stack = [stack]
    }

    // iterate stack and look if there is page instance
    // attached to the route
    const hasPage = stack.filter(o => isPage(o, stage))
    if (hasPage.length) {
      // only allow multiple functions for route
      if (isFunction(type) && !isPage(type, stage)) {
        stack.push(type)
      } else {
        console.warn(`Page for route('${route}') already exists`)
      }
    } else {
      if (isFunction(type)) {
        stack.push(type)
      } else {
        if (!routerConfig.get('lazyCreate')) {
          type = isLightningComponent(type) ? create(type) : type
          pagesHost.a(type)
        }
        stack.push(type)
      }
    }
    pages.set(route, stack)
  } else {
    if (isPage(type, stage)) {
      // if flag lazy eq false we (test) and create
      // correct component and add it to the childList
      if (!routerConfig.get('lazyCreate')) {
        type = isLightningComponent(type) ? create(type) : type
        pagesHost.a(type)
      }
    }

    // if lazy we just store the constructor or function
    pages.set(route, [type])

    // store router modifiers
    if (config) {
      modifiers.set(route, config)
    }
  }
}

/**
 * create a route and define it as root.
 * Upon boot we will automatically point browser hash
 * to the defined route
 * @param route - {string}
 * @param type - {(Lightning.Component|Function()*)}
 */
export const root = (url, type, config) => {
  rootHash = url.replace(/\/+$/, '')
  route(url, type, config)
}

/**
 * Define the widgets that need to become visible per route
 * @param url
 * @param widgets
 */
export const widget = (url, widgets = []) => {
  if (!widgetsPerRoute.has(url)) {
    if (!isArray(widgets)) {
      widgets = [widgets]
    }
    widgetsPerRoute.set(url, widgets)
  } else {
    console.warn(`Widgets already exist for ${url}`)
  }
}

const create = type => {
  const page = stage.c({ type, visible: false })
  // if the app has widgets we make them available
  // as an object on the app instance
  if (widgetsHost) {
    page.widgets = getWidgetReferences()
  }

  return page
}

/**
 * The actual loading of the component
 * @param {String} route - the route blueprint, used for data provider look up
 * @param {String} hash - current hash we're routing to
 * */
const load = async ({ route, hash }) => {
  const type = getPageByRoute(route)
  let routesShareInstance = false
  let provide = false
  let page = null
  let isCreated = false

  // if page is instanceof Component
  if (!type.async && !isLightningComponent(type)) {
    page = type
    // if we have have a data route for current page
    if (providers.has(route)) {
      // if page is expired or new hash is different
      // from previous hash when page was loaded
      // effectively means: page could be loaded
      // with new url parameters
      if (isPageExpired(type) || type[Symbol.for('hash')] !== hash) {
        provide = true
      }
    }

    let currentRoute = activePage && activePage[Symbol.for('route')]

    // if the new route is equal to the current route it means that both
    // route share the Component instance and stack location / since this case
    // is conflicting with the way before() and after() loading works we flag it,
    // and check platform settings in we want to re-use instance
    if (route === currentRoute) {
      routesShareInstance = true
    }
  } else {
    if (type.async) {
      // expect the component to have an injected async factory
      const asyncComponent = await type.loader()
      page = create(asyncComponent || asyncComponent.default)
    } else {
      page = create(type)
    }

    pagesHost.a(page)

    // update stack
    const location = getPageStackLocation(route)
    if (!isNaN(location)) {
      let stack = pages.get(route)
      stack[location] = page
      pages.set(route, stack)
    }

    // test if need to request data provider
    if (providers.has(route)) {
      provide = true
    }

    isCreated = true
  }

  // we store hash and route as properties on the page instance
  // that way we can easily calculate new behaviour on page reload
  page[Symbol.for('hash')] = hash
  page[Symbol.for('route')] = route

  // if routes share instance we only update
  // update the page data if needed
  if (routesShareInstance) {
    if (provide) {
      try {
        await updatePageData({ page, route, hash })
        emit(page, ['dataProvided', 'changed'])
      } catch (e) {
        // show error page with route / hash
        // and optional error code
        handleError(e)
      }
    } else {
      providePageData({ page, route, hash, provide: false })
      emit(page, 'changed')
    }
  } else {
    if (provide) {
      const { type: loadType } = providers.get(route)
      const properties = {
        page,
        old: activePage,
        route,
        hash,
      }
      try {
        if (triggers[loadType]) {
          await triggers[loadType](properties)
          emit(page, ['dataProvided', isCreated ? 'mounted' : 'changed'])
        } else {
          throw new Error(`${loadType} is not supported`)
        }
      } catch (e) {
        handleError(page, e)
      }
    } else {
      const p = activePage
      const r = p && p[Symbol.for('route')]

      providePageData({ page, route, hash, provide: false })
      doTransition(page, activePage).then(() => {
        // manage cpu/gpu memory
        if (p) {
          cleanUp(p, r)
        }

        emit(page, isCreated ? 'mounted' : 'changed')

        // force focus calculation
        app._refocus()
      })
    }
  }

  // store reference to active page, probably better to store the
  // route in the future
  activePage = page
  activeRoute = route
  activeHash = hash

  if (widgetsPerRoute.size && widgetsHost) {
    updateWidgets(page)
  }

  Log.info('[route]:', route)
  Log.info('[hash]:', hash)

  return page
}

const triggerAfter = ({ page, old, route, hash }) => {
  return doTransition(page, old).then(() => {
    // if the current and previous route (blueprint) are equal
    // we're loading the same page again but provide it with new data
    // in that case we don't clean-up the old page (since we're re-using)
    if (old) {
      cleanUp(old, old[Symbol.for('route')])
    }

    // update provided page data
    return updatePageData({ page, route, hash })
  })
}

const triggerBefore = ({ page, old, route, hash }) => {
  return updatePageData({ page, route, hash })
    .then(() => {
      return doTransition(page, old)
    })
    .then(() => {
      if (old) {
        cleanUp(old, old[Symbol.for('route')])
      }
    })
}

const triggerOn = ({ page, old, route, hash }) => {
  // force app in loading state
  app._setState('Loading')

  if (old) {
    cleanUp(old, old[Symbol.for('route')])
  }

  // update provided page data
  return updatePageData({ page, route, hash })
    .then(() => {
      // @todo: fix zIndex for transition
      return doTransition(page)
    })
    .then(() => {
      // back to root state
      app._setState('')
    })
}

const emit = (page, events = [], params = {}) => {
  if (!isArray(events)) {
    events = [events]
  }
  events.forEach(e => {
    const event = `_on${ucfirst(e)}`
    if (isFunction(page[event])) {
      page[event](params)
    }
  })
}

const handleError = (page, error = 'error unkown') => {
  // force expire
  page[Symbol.for('expires')] = Date.now()

  if (pages.has('!')) {
    load({ route: '!', hash: page[Symbol.for('hash')] }).then(errorPage => {
      errorPage.error = { page, error }

      // on() loading type will force the app to go
      // in a loading state so on error we need to
      // go back to root state
      if (app.state === 'Loading') {
        app._setState('')
      }

      // make sure we delegate focus to the error page
      if (activePage !== errorPage) {
        activePage = errorPage
        app._refocus()
      }
    })
  } else {
    Log.error(page, error)
  }
}

const triggers = {
  on: triggerOn,
  after: triggerAfter,
  before: triggerBefore,
}

export const boot = cb => {
  bootRequest = cb
}

const providePageData = ({ page, route, hash }) => {
  const urlValues = getValuesFromHash(hash, route)
  const pageData = new Map([...urlValues, ...register])
  const params = {}

  // make dynamic url data available to the page
  // as instance properties
  for (let [name, value] of pageData) {
    page[name] = value
    params[name] = value
  }

  // check navigation register for persistent data
  if (register.size) {
    const obj = {}
    for (let [k, v] of register) {
      obj[k] = v
    }
    page.persist = obj
  }

  // make url data and persist data available
  // via params property
  page.params = params

  emit(page, ['urlParams'], params)

  return params
}

const updatePageData = ({ page, route, hash, provide = true }) => {
  const { cb, expires } = providers.get(route)
  const params = providePageData({ page, route, hash })

  if (!provide) {
    return Promise.resolve()
  }
  /**
   * In the first version of the Router, a reference to the page is made
   * available to the callback function as property of {params}.
   * Since this is error prone (named url parts are also being spread inside this object)
   * we made the page reference the first parameter and url values the second.
   * -
   * We keep it backwards compatible for now but a warning is showed in the console.
   */
  if (incorrectParams(cb, route)) {
    // keep page as params property backwards compatible for now
    return cb({ page, ...params }).then(() => {
      page[Symbol.for('expires')] = Date.now() + expires
    })
  } else {
    return cb(page, { ...params }).then(() => {
      page[Symbol.for('expires')] = Date.now() + expires
    })
  }
}

/**
 * execute transition between new / old page and
 * toggle the defined widgets
 * @todo: platform override default transition
 * @param pageIn
 * @param pageOut
 */
const doTransition = (pageIn, pageOut = null) => {
  const transition = pageIn.pageTransition || pageIn.easing
  const hasCustomTransitions = !!(pageIn.smoothIn || pageIn.smoothInOut || transition)
  const transitionsDisabled = routerConfig.get('disableTransitions')

  // default behaviour is a visibility toggle
  if (!hasCustomTransitions || transitionsDisabled) {
    pageIn.visible = true
    if (pageOut) {
      pageOut.visible = false
    }
    return Promise.resolve()
  }

  if (transition) {
    let type
    try {
      type = transition.call(pageIn, pageIn, pageOut)
    } catch (e) {
      type = 'crossFade'
    }

    if (isPromise(type)) {
      return type
    }

    if (isString(type)) {
      const fn = Transitions[type]
      if (fn) {
        return fn(pageIn, pageOut)
      }
    }

    // keep backwards compatible for now
    if (pageIn.smoothIn) {
      // provide a smooth function that resolves itself
      // on transition finish
      const smooth = (p, v, args = {}) => {
        return new Promise(resolve => {
          pageIn.visible = true
          pageIn.setSmooth(p, v, args)
          pageIn.transition(p).on('finish', () => {
            resolve()
          })
        })
      }
      return pageIn.smoothIn({ pageIn, smooth })
    }
  }

  return Transitions.crossFade(pageIn, pageOut)
}

/**
 * update the visibility of the available widgets
 * for the current page / route
 * @param page
 */
const updateWidgets = page => {
  const route = page[Symbol.for('route')]

  // force lowercase lookup
  const configured = (widgetsPerRoute.get(route) || []).map(ref => ref.toLowerCase())

  widgetsHost.forEach(widget => {
    widget.visible = configured.indexOf(widget.ref.toLowerCase()) !== -1
    if (widget.visible) {
      emit(widget, ['activated'], page)
    }
  })
}

const cleanUp = (page, route) => {
  let doCleanup = false
  const lazyDestroy = routerConfig.get('lazyDestroy')
  const destroyOnBack = routerConfig.get('destroyOnHistoryBack')
  const keepAlive = read('keepAlive')
  const isFromHistory = read('@router:backtrack')

  if (isFromHistory && (destroyOnBack || lazyDestroy)) {
    doCleanup = true
  } else if (lazyDestroy && !keepAlive) {
    doCleanup = true
  }

  if (doCleanup) {
    // in lazy create mode we store constructor
    // and remove the actual page from host
    const stack = pages.get(route)
    const location = getPageStackLocation(route)

    // grab original class constructor if statemachine routed
    // else store constructor
    stack[location] = page._routedType || page.constructor
    pages.set(route, stack)

    // actual remove of page from memory
    pagesHost.remove(page)

    // force texture gc() if configured
    // so we can cleanup textures in the same tick
    if (routerConfig.get('gcOnUnload')) {
      stage.gc()
    }
  }
}

/**
 * Test if page passed cache-time
 * @param page
 * @returns {boolean}
 */
const isPageExpired = page => {
  if (!page[Symbol.for('expires')]) {
    return false
  }

  const expires = page[Symbol.for('expires')]
  const now = Date.now()

  return now >= expires
}

const getPageByRoute = route => {
  return getPageFromStack(route).item
}

/**
 * Returns the current location of a page constructor or
 * page instance for a route
 * @param route
 */
const getPageStackLocation = route => {
  return getPageFromStack(route).index
}

const getPageFromStack = route => {
  if (!pages.has(route)) {
    return false
  }

  let index = -1
  let item = null
  let stack = pages.get(route)
  if (!Array.isArray(stack)) {
    stack = [stack]
  }

  for (let i = 0, j = stack.length; i < j; i++) {
    if (stack[i].async || isPage(stack[i], stage)) {
      index = i
      item = stack[i]
      break
    }
  }

  return { index, item }
}

/**
 * Simple route length calculation
 * @param route {string}
 * @returns {number} - floor
 */
const getFloor = route => {
  return stripRegex(route).split('/').length
}

/**
 * Test if a route is part regular expressed
 * and replace it for a simple character
 * @param route
 * @returns {*}
 */
const stripRegex = (route, char = 'R') => {
  // if route is part regular expressed we replace
  // the regular expression for a character to
  // simplify floor calculation and backtracking
  if (hasRegex.test(route)) {
    route = route.replace(hasRegex, char)
  }
  return route
}

/**
 * return all stored routes that live on the same floor
 * @param floor
 * @returns {Array}
 */
const getRoutesByFloor = floor => {
  const matches = []
  // simple filter of level candidates
  for (let [route] of pages.entries()) {
    if (getFloor(route) === floor) {
      matches.push(route)
    }
  }
  return matches
}

/**
 * return a matching route by provided hash
 * hash: home/browse/12 will match:
 * route: home/browse/:categoryId
 * @param hash {string}
 * @returns {string|boolean} - route
 */
const getRouteByHash = hash => {
  const getUrlParts = /(\/?:?[@\w%\s-]+)/g
  // grab possible candidates from stored routes
  const candidates = getRoutesByFloor(getFloor(hash))
  // break hash down in chunks
  const hashParts = hash.match(getUrlParts) || []
  // test if the part of the hash has a replace
  // regex lookup id
  const hasLookupId = /\/:\w+?@@([0-9]+?)@@/
  const isNamedGroup = /^\/:/

  // we skip wildcard routes
  const skipRoutes = ['!', '*', '$']

  // to simplify the route matching and prevent look around
  // in our getUrlParts regex we get the regex part from
  // route candidate and store them so that we can reference
  // them when we perform the actual regex against hash
  let regexStore = []

  let matches = candidates.filter(route => {
    let isMatching = true

    if (skipRoutes.indexOf(route) !== -1) {
      return false
    }

    // replace regex in route with lookup id => @@{storeId}@@
    if (hasRegex.test(route)) {
      const regMatches = route.match(hasRegex)
      if (regMatches && regMatches.length) {
        route = regMatches.reduce((fullRoute, regex) => {
          const lookupId = regexStore.length
          fullRoute = fullRoute.replace(regex, `@@${lookupId}@@`)
          regexStore.push(regex.substring(1, regex.length - 1))
          return fullRoute
        }, route)
      }
    }

    const routeParts = route.match(getUrlParts) || []

    for (let i = 0, j = routeParts.length; i < j; i++) {
      const routePart = routeParts[i]
      const hashPart = hashParts[i]

      // Since we support catch-all and regex driven name groups
      // we first test for regex lookup id and see if the regex
      // matches the value from the hash
      if (hasLookupId.test(routePart)) {
        const routeMatches = hasLookupId.exec(routePart)
        const storeId = routeMatches[1]
        const routeRegex = regexStore[storeId]

        // split regex and modifiers so we can use both
        // to create a new RegExp
        // eslint-disable-next-line
        const regMatches = /\/([^\/]+)\/([igm]{0,3})/.exec(routeRegex)

        if (regMatches && regMatches.length) {
          const expression = regMatches[1]
          const modifiers = regMatches[2]

          const regex = new RegExp(`^/${expression}$`, modifiers)

          if (!regex.test(hashPart)) {
            isMatching = false
          }
        }
      } else if (isNamedGroup.test(routePart)) {
        // we kindly skip namedGroups because this is dynamic
        // we only need to the static and regex drive parts
        continue
      } else if (hashPart && routePart.toLowerCase() !== hashPart.toLowerCase()) {
        isMatching = false
      }
    }
    return isMatching
  })

  if (matches.length) {
    // we give prio to static routes over dynamic
    matches = matches.sort(a => {
      return isNamedGroup.test(a) ? -1 : 1
    })
    return matches[0]
  }

  return false
}

/**
 * Extract dynamic values from location hash and return a namedgroup
 * of key (from route) value (from hash) pairs
 * @param hash {string} - the actual location hash
 * @param route {string} - the route as defined in route
 */
const getValuesFromHash = (hash, route) => {
  // replace the regex definition from the route because
  // we already did the matching part
  route = stripRegex(route, '')

  const getUrlParts = /(\/?:?[\w%\s-]+)/g
  const hashParts = hash.match(getUrlParts) || []
  const routeParts = route.match(getUrlParts) || []
  const getNamedGroup = /^\/:([\w-]+)\/?/

  return routeParts.reduce((storage, value, index) => {
    const match = getNamedGroup.exec(value)
    if (match && match.length) {
      storage.set(match[1], decodeURIComponent(hashParts[index].replace(/^\//, '')))
    }
    return storage
  }, new Map())
}

const handleHashChange = override => {
  const hash = override || getHash()
  const route = getRouteByHash(hash)

  if (route) {
    // would be strange if this fails but we do check
    if (pages.has(route)) {
      let stored = pages.get(route)
      if (!isArray(stored)) {
        stored = [stored]
      }
      let n = stored.length
      while (n--) {
        const type = stored[n]
        if (type.async || isPage(type, stage)) {
          load({ route, hash }).then(() => {
            app._refocus()
          })
        } else {
          const urlParams = getValuesFromHash(hash, route)
          const params = {}
          for (const key of urlParams.keys()) {
            params[key] = urlParams.get(key)
          }
          // invoke
          type.call(null, app, { ...params })
        }
      }
    }
  } else {
    if (pages.has('*')) {
      load({ route: '*', hash }).then(() => {
        app._refocus()
      })
    }
  }
}

const getMod = (hash, key) => {
  const config = modifiers.get(getRouteByHash(hash))
  if (isObject(config)) {
    return config[key]
  }
}

const hashmod = (hash, key) => {
  return routemod(getRouteByHash(hash), key)
}

const routemod = (route, key) => {
  if (modifiers.has(route)) {
    const config = modifiers.get(route)
    if (config[key] && config[key] === true) {
      return true
    }
  }
  return false
}

const read = flag => {
  if (register.has(flag)) {
    return register.get(flag)
  }
  return false
}

const createRegister = flags => {
  const reg = new Map()
  Object.keys(flags).forEach(key => {
    reg.set(key, flags[key])
  })
  return reg
}

export const navigate = (url, args, store = true) => {
  register.clear()

  let hash = getHash()
  if (!mustUpdateHash() && forcedHash) {
    hash = forcedHash
  }

  const storeHash = getMod(hash, 'store')
  let configPrevent = hashmod(hash, 'preventStorage')
  let configStore = true

  if ((isBoolean(storeHash) && storeHash === false) || configPrevent) {
    configStore = false
  }

  if (isObject(args)) {
    register = createRegister(args)
    if (isBoolean(store) && !store) {
      store = false
    }
  } else if (isBoolean(args) && !args) {
    // if explicit set to false we don't want
    // to store the route
    store = false
  }

  if (hash && store && configStore) {
    const toStore = hash.replace(/^\//, '')
    const location = history.indexOf(toStore)
    // store hash if it's not a part of history or flag for
    // storage of same hash is true
    if (location === -1 || routerConfig.get('storeSameHash')) {
      history.push(toStore)
    } else {
      // if we visit the same route we want to sync history
      history.push(history.splice(location, 1)[0])
    }
  }

  // clean up history if modifier is set
  if (hashmod(url, 'clearHistory')) {
    history.length = 0
  }

  if (hash.replace(/^#/, '') !== url) {
    if (!mustUpdateHash()) {
      forcedHash = url
      handleHashChange(url)
    } else {
      setHash(url)
    }
  } else if (read('reload')) {
    handleHashChange(hash)
  }
}

/**
 * Directional step in history
 * @param direction
 */
export const step = (direction = 0) => {
  if (!direction) {
    return false
  }

  // is we still have routes in our history
  // we splice the last of and navigate to that route
  if (history.length) {
    // for now we only support history back
    const route = history.splice(history.length - 1, 1)
    return navigate(route[0], { backtrack: true }, false)
  } else if (routerConfig.get('backtrack')) {
    const hashLastPart = /(\/:?[\w%\s-]+)$/
    let hash = stripRegex(getHash())
    let floor = getFloor(hash)

    // test if we got deeplinked
    if (floor > 1) {
      while (floor--) {
        // strip of last part
        hash = hash.replace(hashLastPart, '')
        // if we have a configured route
        // we navigate to it
        if (getRouteByHash(hash)) {
          return navigate(hash, { '@router:backtrack': true }, false)
        }
      }
    }
  }

  if (isFunction(app._handleAppClose)) {
    return app._handleAppClose()
  }

  return false
}

const capture = ({ key }) => {
  if (!routerConfig.get('numberNavigation')) {
    return false
  }
  key = parseInt(key)
  if (!isNaN(key)) {
    let match
    let idx = 1
    for (let route of pages.keys()) {
      if (idx === key) {
        match = route
        break
      } else {
        idx++
      }
    }
    if (match) {
      navigate(match)
    }
  }
  return false
}

// start translating url
export const start = () => {
  const bootKey = '@boot-page'
  const hasBootPage = pages.has('@boot-page')
  const hash = getHash()
  const params = getQueryStringParams(hash)

  // if we refreshed the boot-page we don't want to
  // redirect to this page so we force rootHash load
  const isDirectLoad = hash.indexOf(bootKey) !== -1
  const ready = () => {
    if (hasBootPage) {
      navigate('@boot-page', {
        resume: isDirectLoad ? rootHash : hash || rootHash,
        reload: true,
      })
    } else if (!hash && rootHash) {
      if (isString(rootHash)) {
        navigate(rootHash)
      } else if (isFunction(rootHash)) {
        rootHash().then(url => {
          navigate(url)
        })
      }
    } else {
      handleHashChange()
    }
  }
  if (isFunction(bootRequest)) {
    bootRequest(params).then(() => {
      ready()
    })
  } else {
    ready()
  }
}

/**
 * Data binding to a route will invoke a loading screen
 * @param {String} route - the route
 * @param {Function} cb - must return a promise
 * @param {Number} expires - seconds after first time active that data expires
 * @param {String} type - page loading type
 */
export const on = (route, cb, expires = 0, type = 'on') => {
  if (providers.has(route)) {
    console.warn(`provider for ${route} already exists`)
  } else {
    providers.set(route, {
      cb,
      expires: expires * 1000,
      type,
    })
  }
}

/**
 * Request data binding for a route before
 * the page loads (active page will stay visible)
 * @param route
 * @param cb
 * @param expires
 */
export const before = (route, cb, expires = 0) => {
  on(route, cb, expires, 'before')
}

/**
 * Request data binding for a route after the page has
 * been loaded
 * @param route
 * @param cb
 * @param expires
 */
export const after = (route, cb, expires = 0) => {
  on(route, cb, expires, 'after')
}

const getWidgetReferences = () => {
  return widgetsHost.get().reduce((storage, widget) => {
    const key = widget.ref.toLowerCase()
    storage[key] = widget
    return storage
  }, {})
}

const getWidgetByName = name => {
  name = ucfirst(name)
  return widgetsHost.getByRef(name) || false
}

/**
 * delegate app focus to a on-screen widget
 * @param name - {string}
 */
export const focusWidget = name => {
  const widget = getWidgetByName(name)
  if (name) {
    // store reference
    activeWidget = widget
    // somewhat experimental
    if (app.state === 'Widgets') {
      app.reload(activeWidget)
    } else {
      app._setState('Widgets', [activeWidget])
    }
  }
}

export const handleRemote = (type, name) => {
  if (type === 'widget') {
    focusWidget(name)
  } else if (type === 'page') {
    restoreFocus()
  }
}

/**
 * Resume Router's page loading process after
 * the BootComponent became visible;
 */
export const resume = () => {
  if (register.has('resume')) {
    const hash = register.get('resume').replace(/^#+/, '')
    if (getRouteByHash(hash) && hash) {
      navigate(hash, false)
    } else if (rootHash) {
      navigate(rootHash, false)
    }
  }
}

export const restore = () => {
  if (routerConfig.get('autoRestoreRemote')) {
    handleRemote('page')
  }
}

const hash = () => {
  return getHash()
}

const mustUpdateHash = () => {
  // we need support to either turn change hash off
  // per platform or per app
  const updateConfig = routerConfig.get('updateHash')
  return !((isBoolean(updateConfig) && !updateConfig) || (isBoolean(updateHash) && !updateHash))
}

export const restoreFocus = () => {
  app._setState('Pages')
}

export const getActivePage = () => {
  if (activePage && activePage.attached) {
    return activePage
  } else {
    return app
  }
}

export const getActiveRoute = () => {
  return activeRoute
}

export const getActiveHash = () => {
  return activeHash
}

export const getActiveWidget = () => {
  return activeWidget
}

// listen to url changes
window.addEventListener('hashchange', () => {
  handleHashChange()
})

// export API
export default {
  startRouter,
  navigate,
  root,
  resume,
  route,
  on,
  before,
  after,
  boot,
  step,
  restoreFocus,
  focusPage: restoreFocus,
  focusWidget,
  handleRemote,
  start,
  add: setupRoutes,
  widget,
  hash,
  getActivePage,
  getActiveWidget,
  getActiveRoute,
  getActiveHash,
  App: RoutedApp,
  restore,
}
