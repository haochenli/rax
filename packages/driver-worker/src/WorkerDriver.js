import createWorkerGlobalScope from './worker/createWorkerGlobalScope';
import Evaluator from './worker/Evaluator';
import Driver from './Driver';

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const COMMENT_NODE = 8;
const BODY = 'BODY';
const STYLE_ELEMENT = 'STYLE';
const IS_TOUCH_EVENTS = /^touch/;
const TO_SANITIZE = [
  'target',
  'addedNodes',
  'removedNodes',
  'nextSibling',
  'previousSibling',
];

export default class WorkerDriver extends Driver {
  constructor(options = {}) {
    const { postMessage, addEventListener } = options;
    const workerGlobalScope = createWorkerGlobalScope();
    super(workerGlobalScope.document);

    this.evaluator = new Evaluator(postMessage);
    this.nodesMap = new Map();
    this.nodeCounter = 0;

    let mutationObserver = this.createMutationObserver(postMessage);
    mutationObserver.observe(this.document, { subtree: true });

    addEventListener('message', this.handleMessage);
  }

  createMutationObserver(callback) {
    const MutationObserver = this.document.defaultView.MutationObserver;
    return new MutationObserver(mutations => {
      for (let i = mutations.length; i--;) {
        let mutation = mutations[i];
        for (let j = TO_SANITIZE.length; j--;) {
          let prop = TO_SANITIZE[j];
          const value = this.sanitize(mutation[prop], prop);
          if (value) mutation[prop] = value;
        }
      }

      callback({
        type: 'MutationRecord',
        mutations: this.excludeEmptyMutations(mutations),
      });
    });
  }

  /**
   * Reduce size of mutations, exclude empty operation.
   */
  excludeEmptyMutations(mutations) {
    const results = [];
    for (let i = 0, l = mutations.length; i < l; i++) {
      const mutation = mutations[i];

      if (mutation.hasOwnProperty('addedNodes')
        && mutation.addedNodes.length === 0) {
        continue;
      }

      if (mutation.hasOwnProperty('removedNodes')
        && mutation.removedNodes.length === 0) {
        continue;
      }

      results.push(mutation);
    }
    return results;
  }

  /**
   * Event `message' listener.
   */
  handleMessage = ({ data }) => {
    const document = this.document;
    switch (data.type) {
      case 'init':
        document.URL = data.url;
        document.documentElement.clientWidth = data.width;
        break;
      case 'event':
        this.handleEvent(data.event);
        break;
      case 'return':
        this.handleReturn(data.return);
        break;
    }
  };

  hitStyle = {};

  /**
   * Serialize instruction.
   */
  sanitize(node, prop) {
    if (!node || typeof node !== 'object') {
      return node;
    }

    if (Array.isArray(node)) {
      let ret = [];
      for (let i = 0, l = node.length; i < l; i ++) {
        const sanitized = this.sanitize(node[i], prop);
        if (sanitized !== null) ret.push(sanitized);
      }
      return ret;
    }

    if (!node.$$id) {
      node.$$id = String(++this.nodeCounter);
      this.nodesMap.set(node.$$id, node);
    }

    const result = {
      $$id: node.$$id,
    };

    if (node.nodeName === BODY) {
      result.nodeName = BODY;
    } else if (prop === 'removedNodes') {
      // Do not remove style tags.
      if (node.nodeName === STYLE_ELEMENT) return null;
    } else if (prop === 'addedNodes') {
      const nodeType = node.nodeType;
      result.nodeType = nodeType;

      switch (nodeType) {
        case ELEMENT_NODE:
          result.nodeName = node.nodeName;
          /**
           * @NOTE: Performance purpose.
           * Deduplicate same style tags.
           * Use tree mode, instead of node.
           */
          if (node.nodeName === STYLE_ELEMENT) {
            if (node.firstChild && node.firstChild.nodeType === TEXT_NODE) {
              const textNode = node.firstChild;
              const textStyle = textNode.data;
              if (this.hitStyle[textStyle]) {
                return null;
              } else {
                this.hitStyle[textStyle] = true;
                result.childNodes = [{ nodeType: TEXT_NODE, data: textStyle }];
              }
            }
          }

          const events = node._getEvents();
          if (events.length > 0) result.events = events;
          if (node.attributes && node.attributes.length > 0) result.attributes = node.attributes;
          if (Object.keys(node.style).length > 0) result.style = node.style;
          break;

        case TEXT_NODE:
          if (node.parentNode
            && node.parentNode.nodeName === STYLE_ELEMENT) return null; // fall through
        case COMMENT_NODE:
          result.data = node.data;
          break;
      }
    }

    return result;
  }

  getNode(node) {
    let id;
    if (node && typeof node === 'object') id = node.$$id;
    if (typeof node === 'string') id = node;
    if (!id) return null;
    if (node.nodeName === BODY) return this.document.body;
    return this.nodesMap.get(id);
  }

  handleEvent(event) {
    const target = this.getNode(event.target);

    if (IS_TOUCH_EVENTS.test(event.type)) {
      event = this.convertTouchTarget(event);
    }

    if (target) {
      event.target = target;
      target.dispatchEvent(event);
    }
  }

  handleReturn(data) {
    this.evaluator.apply(data);
  }

  /**
   * Convert TouchEvent#$$id to targetNode
   */
  extractTouchListTarget(touchList) {
    for (let i = 0, l = touchList.length; i < l; i++) {
      if ('$$id' in touchList[i]) {
        touchList[i].target = this.getNode(touchList[i].$$id);
        delete touchList[i].$$id;
      }
    }
  }

  /**
   * Extract touches and currentTouches
   */
  convertTouchTarget(evt) {
    if (evt.touches) {
      this.extractTouchListTarget(evt.touches);
    }
    if (evt.changedTouches) {
      this.extractTouchListTarget(evt.changedTouches);
    }
    return evt;
  }
}
