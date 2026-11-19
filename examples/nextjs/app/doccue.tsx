'use client';
/**
 * The DocCue frontend: one bridge for the life of the page. It records what the user does from
 * the moment it is created, across client-side navigations, so it lives outside React's tree and
 * is created once, even when React runs effects twice in development.
 */
import { useEffect } from 'react';
import { createBridge, type Bridge } from '@doccue/bridge';

let bridge: Bridge | undefined;

export function DocCue() {
  useEffect(() => {
    if (bridge) return;
    bridge = createBridge({ endpoint: '/doccue' });
    void bridge.mount(); // the chat button in the corner
  }, []);
  return null;
}
