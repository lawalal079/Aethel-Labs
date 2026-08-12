'use client';

import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[Æthel ErrorBoundary] Uncaught client-side exception:', error, errorInfo);
  }

  private handleReload = () => {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen w-full bg-[#0B0B0C] text-[#e5e2e1] flex items-center justify-center p-6 font-sans">
          <div className="max-w-md w-full bg-[#15181C] border border-[#2A2F35] rounded-2xl p-6 shadow-2xl space-y-4 text-center">
            <div className="w-12 h-12 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center mx-auto text-xl font-bold">
              ⚠️
            </div>
            <div className="space-y-1">
              <h3 className="text-base font-bold text-white tracking-wide">
                Application Recovery
              </h3>
              <p className="text-xs text-[#8a8f98] leading-relaxed">
                A temporary client-side state issue occurred. Click below to reload the workspace safely.
              </p>
            </div>
            {this.state.error?.message && (
              <div className="bg-[#0B0B0C] border border-[#2A2F35] rounded-lg p-3 text-[11px] font-mono text-amber-300/80 text-left overflow-x-auto max-h-24 scrollbar-none">
                {this.state.error.message}
              </div>
            )}
            <button
              onClick={this.handleReload}
              type="button"
              className="w-full py-2.5 px-4 bg-[#4E8981] hover:bg-[#4E8981]/90 active:scale-[0.98] text-white text-xs font-bold font-mono rounded-xl shadow-lg transition-all cursor-pointer"
            >
              🔄 Refresh Application
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
