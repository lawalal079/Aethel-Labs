'use client';

import React from 'react';
import { AppProvider } from './context';
import Header from './header';
import Sidebar from './sidebar';
import Workspace from './workspace';
import { Web3Provider } from './components/providers/Web3Provider';

import Link from 'next/link';

import { ErrorBoundary } from './components/ErrorBoundary';

export default function Home() {
  return (
    <ErrorBoundary>
      <Web3Provider>
        <AppProvider>
          <div className="h-screen w-full bg-[#0B0B0C] text-[#e5e2e1] overflow-hidden p-4 font-sans flex gap-4">
            {/* Vertical Sidebar Component */}
            <Sidebar />

            {/* Right Area: Header + Workspace Content */}
            <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
              {/* Dynamic header navigation - stays pinned at the top */}
              <Header />

              {/* Active main tab workspace view - this is the ONLY scrollable area */}
              <main className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 pr-1 pb-2 scrollbar-none [&::-webkit-scrollbar]:hidden">
                <Workspace />
              </main>

              {/* Sticky HUD Footer */}
              <footer className="h-8 border-t border-[#2A2F35]/50 flex items-center justify-between px-2 text-[11px] text-[#8a8f98] shrink-0">
                <span>© 2026 Æthel Labs. Secured by USDC splits.</span>
              </footer>
            </div>
          </div>
        </AppProvider>
      </Web3Provider>
    </ErrorBoundary>
  );
}
