/* @flow */

import t from 'transducers.js';
import LiveSet from 'live-set';
import type {LiveSetController, LiveSetSubscription} from 'live-set';
import liveSetTransduce from 'live-set/transduce';
import liveSetMerge from 'live-set/merge';
import liveSetFilter from 'live-set/filter';
import liveSetFlatMap from 'live-set/flatMap';
import liveSetMap from 'live-set/map';
import {TagTree} from 'tag-tree';
import type {TagTreeController, TagTreeNode} from 'tag-tree';
import matchesSelector from 'matches-selector-ng';

import makeElementChildLiveSet from './makeElementChildLiveSet';

export type Selector =
  string
  // The children operator: this will change the matched set to contain only
  // the direct children of the current matched set, and then filters them
  // based on a css selector string.

  | {| $filter: (el: HTMLElement) => boolean |}
  // The $filter operator allows you to specify a function which will be called
  // on every matched element. If the function returns false, then the element
  // will be removed from the matched set.

  | {| $map: (el: HTMLElement) => ?HTMLElement |}
  // The $map operator allows you to specify a function which will be called
  // on every matched element, and each element in the matched set will be
  // replaced with the element returned by your function. If your function
  // returns null, then the element will just be removed from the matched set.

  | {| $watch: {| attributeFilter: string[], cond: string | (el: HTMLElement) => boolean |} |}
  // The $watch operator allows you to specify either an attributeFilter list
  // and a css selector string or function. The currently matched elements
  // will be removed from the matched set if they don't match the css selector
  // string or pass the given function. If the element has any list attributes
  // changed, then it will be re-considered and may be added or removed from
  // the matched set.

  | {| $or: Array<Array<Selector>> |}
  // The $or operator forks the operator list into multiple lists, and then
  // re-combines the resulting matched sets.

  | {| $log: string |}
  // The $log operator uses `console.log` to log every element in the matched
  // set to the console with a given string prefix.
;

export type Watcher = {|
  sources: Array<string|null>;
  tag: string;
  selectors: Array<Selector>;
|};

export type Finder = {|
  fn(root: HTMLElement): Array<HTMLElement> | NodeList<HTMLElement>;
  interval?: ?number;
|};

export type TagOptions = {
  ownedBy?: ?Array<string>;
};

export type PageParserTreeOptions = {|
  logError?: ?(err: Error, el: ?HTMLElement) => void;
  tags: {[tag:string]: TagOptions};
  watchers: Array<Watcher>;
  finders: {[tag:string]: Finder};
|};

type NodeTagPair = {|
  tag: ?string;
  node: TagTreeNode<HTMLElement>;
|};

export type ElementContext = {|
  el: HTMLElement;
  parents: Array<NodeTagPair>;
|};

function makeLiveSetTransformer(selectors: Array<Selector>): LiveSetTransformer {
  const transformers = selectors.map(item => {
    if (typeof item === 'string') {
      const itemString = item;
      const filterXf = t.filter(el => matchesSelector(el, itemString));
      const flatMapFn = ec => {
        const transducer = t.compose(
          filterXf,
          t.map(el => ({el, parents: ec.parents}))
        );
        return liveSetTransduce(makeElementChildLiveSet(ec.el), transducer);
      };
      return liveSet => liveSetFlatMap(liveSet, flatMapFn);
    } else if (item.$or) {
      const transformers = item.$or.map(makeLiveSetTransformer);
      return liveSet =>
        liveSetMerge(transformers.map(transformer =>
          transformer(liveSet)
        ));
    } else if (item.$watch) {
      throw new Error('TODO');
    } else if (item.$log) {
      const {$log} = item;
      const filterFn = value => {
        console.log($log, value.el); //eslint-disable-line no-console
        return true;
      };
      return liveSet => liveSetFilter(liveSet, filterFn);
    } else if (item.$filter) {
      const {$filter} = item;
      const filterFn = ({el}) => $filter(el);
      return liveSet => liveSetFilter(liveSet, filterFn);
    } else if (item.$map) {
      const {$map} = item;
      const transducer = t.compose(
        t.map(ec => ({el: $map(ec.el), parents: ec.parents})),
        t.filter(ec => ec.el != null)
      );
      return liveSet => liveSetTransduce(liveSet, transducer);
    }
    throw new Error(`Invalid selector item: ${JSON.stringify(item)}`);
  });

  return transformers.reduce((combined, transformer) => {
    return liveSet => transformer(combined(liveSet));
  }, x => x);
}

type LiveSetTransformer = (liveSet: LiveSet<ElementContext>) => LiveSet<ElementContext>;

export default class PageParserTree {
  tree: TagTree<HTMLElement>;
  _treeController: TagTreeController<HTMLElement>;

  _rootMatchedSet: LiveSet<ElementContext>;
  _ecSources: Map<string, {
    liveSet: LiveSet<LiveSet<ElementContext>>;
    controller: LiveSetController<LiveSet<ElementContext>>;
    ecSet: LiveSet<ElementContext>;
  }>;

  _logError: (err: Error, el: ?HTMLElement) => void;
  _options: PageParserTreeOptions;
  _tagOptions: Map<string, TagOptions>;
  _watcherLiveSetTransformers: Map<Array<Selector>, LiveSetTransformer>;
  _subscriptions: Array<LiveSetSubscription> = [];

  constructor(root: Document|HTMLElement, options: PageParserTreeOptions) {
    let rootEl;
    if (root.nodeType === Node.DOCUMENT_NODE) {
      rootEl = ((root:any):Document).documentElement;
      if (!rootEl) throw new Error('missing documentElement');
    } else {
      rootEl = (root:any);
    }

    this._options = options;
    this._logError = options.logError || function(err) {
      setTimeout(() => {
        throw err;
      }, 0);
    };

    this._tagOptions = new Map();
    const tags = [];
    Object.keys(this._options.tags).forEach(tag => {
      const tagOptions = this._options.tags[tag];
      const {ownedBy} = tagOptions;
      tags.push({tag, ownedBy});
      this._tagOptions.set(tag, tagOptions);
    });
    this._options.watchers.forEach(watcher => {
      const {tag} = watcher;
      if (!this._tagOptions.has(tag)) {
        this._tagOptions.set(tag, {});
        tags.push({tag});
      }
    });

    this.tree = new TagTree({
      root: rootEl,
      tags,
      executor: controller => {
        this._treeController = controller;
      }
    });
    this._watcherLiveSetTransformers = new Map(
      this._options.watchers.map(({selectors}) =>
        [selectors, makeLiveSetTransformer(selectors)]
      )
    );
    this._rootMatchedSet = LiveSet.constant(new Set([{
      el: this.tree.getValue(),
      parents: [{tag: null, node: this.tree}]
    }]));

    this._ecSources = new Map(tags.map(({tag}) => {
      const {liveSet, controller} = LiveSet.active();
      const ecSet = liveSetFlatMap(liveSet, s => s);
      return [tag, {liveSet, controller, ecSet}];
    }));

    this._options.watchers.forEach(({sources, selectors, tag}) => {
      const tagOptions = this._tagOptions.get(tag);
      if (!tagOptions) throw new Error();
      const ownedBy = new Set(tagOptions.ownedBy || []);

      function findParentNode(taggedParents: NodeTagPair[]): TagTreeNode<HTMLElement> {
        let parentNode;
        for (let i=taggedParents.length-1; i>=0; i--) {
          if (taggedParents[i].tag == null || ownedBy.has(taggedParents[i].tag)) {
            parentNode = taggedParents[i].node;
            break;
          }
        }
        if (!parentNode) throw new Error();
        return parentNode;
      }

      const sourceSets = sources.map(tag => {
        if (!tag) return this._rootMatchedSet;
        const entry = this._ecSources.get(tag);
        if (!entry) throw new Error('Unknown source: '+tag);
        return entry.ecSet;
      });
      const sourceSet = sourceSets.length === 1 ? sourceSets[0] : liveSetMerge(sourceSets);
      const transformer = this._watcherLiveSetTransformers.get(selectors);
      if (!transformer) throw new Error();

      const elementsToNodes: Map<HTMLElement, TagTreeNode<HTMLElement>> = new Map();

      const outputSet = liveSetMap(transformer(sourceSet), ec => {
        const {el, parents} = ec;
        const parentNode = findParentNode(parents);
        const node = this._treeController.addTaggedValue(parentNode, tag, el);
        if (elementsToNodes.has(el)) {
          throw new Error('received element twice'); // TODO logError
        }
        elementsToNodes.set(el, node);

        const newParents = ec.parents.concat([{tag, node}]);
        return {el, parents: newParents};
      });

      this._subscriptions.push(outputSet.subscribe(changes => {
        changes.forEach(change => {
          if (change.type === 'remove') {
            const node = elementsToNodes.get(change.value.el);
            if (!node) throw new Error('Should not happen: received removal of unseen element');
            elementsToNodes.delete(change.value.el);
            const nodeParent = node.getParent();

            // The node might have already been removed from the tree if it
            // is owned by a node that was just removed.
            if (nodeParent && nodeParent.ownsNode(node)) {
              this._treeController.removeTaggedNode(nodeParent, tag, node);
            }
          }
        });
      }));

      const ecEntry = this._ecSources.get(tag);
      if (!ecEntry) throw new Error();
      ecEntry.controller.add(outputSet);
    });

    this._subscriptions.forEach(sub => {
      sub.pullChanges();
    });
  }

  //TODO
  // Intended for use with hot module replacement.
  // replaceOptions(options: Array<PageParserTreeOptions>) {
  // }
}
