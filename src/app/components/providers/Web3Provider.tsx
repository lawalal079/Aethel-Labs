'use client';

import React from 'react';

if (typeof window !== 'undefined') {
  // Suppress harmless extension / wallet warnings
  const originalError = console.error;
  console.error = (...args: any[]) => {
    const msg = args.map(arg => (arg && arg.message) || String(arg)).join(' ');
    if (
      msg.includes('Cannot set property ethereum') ||
      msg.includes('pageProvider.js') ||
      msg.includes('unique "key" prop') ||
      msg.includes('Check the render method of')
    ) {
      return;
    }
    originalError.apply(console, args);
  };

  const originalWarn = console.warn;
  console.warn = (...args: any[]) => {
    const msg = args.map(arg => String(arg)).join(' ');
    if (
      msg.includes('Error generating app config') ||
      msg.includes('signal is aborted') ||
      msg.includes('AbortError')
    ) {
      return;
    }
    originalWarn.apply(console, args);
  };
}

export function Web3Provider({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
