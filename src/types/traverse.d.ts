// @flow
/* eslint no-unused-vars: off */

type TraverseCallback = (type: string, path: NodePath<Node>) => void;

type NodePathContext<T> = {
  node: T,
  inList: boolean,
  shouldStop: boolean,
  parentPath?: NodePath<Node>,
  parentKey?: string
};

type NodePathMatcher = (a: NodePath<Node>) => boolean;
type NodeLocator = (NodePathMatcher) => Node | null;

type NodePathOperations = {
  findParent: NodeLocator,
  replaceWith: (a: Node) => void,
  remove: () => void,
  insertBefore: (a: Node) => void,
  insertAfter: (a: Node) => void,
  stop: () => void
};

type NodePath<T> = NodePathContext<T> & NodePathOperations;
