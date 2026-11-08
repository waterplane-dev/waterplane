/** `useRemoteResource`'s link verdict in a webview: there is no socket to lose, so the caller's `offline` decides. */
export const linkOnline = (): boolean => true;
/** Nothing here ever changes that verdict, so a subscriber is never called. */
export const subscribeLink = (_listener: () => void): (() => void) => () => {};
