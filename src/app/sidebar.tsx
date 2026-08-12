'use client';

import React from 'react';
import { useApp } from './context';

// Exact Custom Storefront Icon matching Screenshot 2
const MarketplaceIcon = ({ className = "w-7 h-7" }: { className?: string }) => (
  <svg viewBox="0 0 32 32" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
    {/* Storefront roof/canopy */}
    <path d="M4 14h24l-2.4-6H6.4L4 14z" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M4 14c0 1.5.8 2 1.6 2c.8 0 1.6-.5 1.6-2M7.2 14c0 1.5.8 2 1.6 2c.8 0 1.6-.5 1.6-2M10.4 14c0 1.5.8 2 1.6 2c.8 0 1.6-.5 1.6-2M13.6 14c0 1.5.8 2 1.6 2c.8 0 1.6-.5 1.6-2M16.8 14c0 1.5.8 2 1.6 2c.8 0 1.6-.5 1.6-2M20 14c0 1.5.8 2 1.6 2c.8 0 1.6-.5 1.6-2M23.2 14c0 1.5.8 2 1.6 2c.8 0 1.6-.5 1.6-2M26.4 14c0 1.5.8 2 1.6 2c.8 0 1.6-.5 1.6-2" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    {/* Main stall base and door */}
    <path d="M6.4 16v10h19.2V16" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M12.5 26v-6.5h7V26" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// Exact Double Gear Icon with Checkmark Overlay matching Screenshot 3
const MyAgentsIcon = ({ className = "w-7 h-7" }: { className?: string }) => (
  <svg viewBox="0 0 32 32" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
    {/* Large gear (bottom-left) */}
    <circle cx="12" cy="20" r="4.5" stroke="currentColor" strokeWidth="2.2" />
    {/* Teeth for large gear */}
    <path d="M12 12.5v3M12 24.5v3M4.5 20h3M19.5 20h3M6.7 14.7l2.1 2.1M15.2 23.2l2.1 2.1M6.7 25.3l2.1-2.1M15.2 16.8l2.1-2.1" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    
    {/* Small gear (top-right) */}
    <circle cx="21" cy="11" r="2.8" stroke="currentColor" strokeWidth="2.2" />
    {/* Teeth for small gear */}
    <path d="M21 5.5v2.5M21 14v2.5M15.5 11h2.5M24 11h2.5M17.1 7.1l1.8 1.8M23.1 13.1l1.8 1.8M17.1 14.9l1.8-1.8M23.1 7.1l1.8-1.8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    
    {/* Checkmark badge (bottom-right) */}
    <circle cx="23" cy="23" r="5" fill="#1A1D20" stroke="currentColor" strokeWidth="2" />
    <path d="M20.5 23l1.5 1.5 3-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// Exact Workflows Tree Icon
const WorkflowsIcon = ({ className = "w-7 h-7" }: { className?: string }) => (
  <svg viewBox="0 0 32 32" className={className} fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    {/* Root node */}
    <rect x="5" y="13" width="6" height="6" rx="1.5" />
    {/* Branching lines */}
    <path d="M11 16h4v-5h4M15 16v5h4" />
    {/* Top child node */}
    <rect x="19" y="8" width="6" height="6" rx="1.5" />
    {/* Bottom child node */}
    <rect x="19" y="18" width="6" height="6" rx="1.5" />
  </svg>
);

// Billing sidebar icon — receipt scroll + dollar coin, matches reference image exactly
const BillingLockIcon = ({ className = "w-7 h-7" }: { className?: string }) => (
  <svg viewBox="0 0 32 32" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
    {/* Receipt Paper Outline & Curls */}
    <path d="M9 6h12c1.66 0 3 1.34 3 3v2" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M9 6a2 2 0 00-2 2v14a2 2 0 002 2h9" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    
    {/* Top Curl Flap */}
    <path d="M21 6h2c1.1 0 2 .9 2 2v0c0 1.1-.9 2-2 2h-2" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    
    {/* Bottom Curl Flap */}
    <path d="M7 22h13c1.1 0 2 .9 2 2v0c0 1.1-.9 2-2 2H9c-1.1 0-2-.9-2-2z" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    
    {/* Horizontal text lines */}
    <path d="M11 10h9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <path d="M11 14h9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <path d="M11 18h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />

    {/* Overlapping Dollar Coin */}
    <circle cx="23" cy="19" r="6" fill="#1A1D20" stroke="currentColor" strokeWidth="2.2" />
    {/* Dollar sign inside the coin */}
    <path d="M23 15.5v7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    <path d="M25 17.5c0-.8-.7-1.3-1.5-1.3s-1.5.5-1.5 1.3.7 1.3 1.5 1.3 1.5.5 1.5 1.3-.7 1.3-1.5 1.3-1.5-.5-1.5-1.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export default function Sidebar() {
  const { activeTab, setActiveTab } = useApp();

  const navigationItems = [
    {
      id: 'marketplace' as const,
      label: 'Marketplace',
      icon: MarketplaceIcon,
      disabled: false,
    },
    {
      id: 'my-agents' as const,
      label: 'My Agents',
      icon: MyAgentsIcon,
      disabled: false,
    },
    {
      id: 'workflows' as const,
      label: 'Agent Portal',
      icon: WorkflowsIcon,
      disabled: false,
    },
    {
      id: 'billing' as const,
      label: 'Billing',
      icon: BillingLockIcon,
      disabled: false,
    },
  ];

  return (
    <aside className="w-[80px] md:w-[88px] h-fit self-center bg-[#1A1D20] border border-[#2A2F35] rounded-2xl flex flex-col items-center py-4 gap-1.5 shrink-0 select-none shadow-2xl relative z-20 overflow-hidden">
      {/* Navigation Links */}
      <nav className="flex flex-col gap-1 w-full items-center px-2">
        {navigationItems.map((item) => {
          const IconComponent = item.icon;
          const isActive = activeTab === item.id;
          const isDisabled = item.disabled;

          return (
            <div key={item.id} className={`relative w-full flex items-center ${isDisabled ? 'opacity-30' : ''}`}>
              {/* Active left-strip indicator */}
              <div
                className={`absolute left-0 top-1/2 -translate-y-1/2 w-[3px] rounded-r-full transition-all duration-200 ${
                  isActive && !isDisabled ? 'h-8 bg-[#4E8981]' : 'h-0 bg-transparent'
                }`}
              />
              <button
                onClick={() => !isDisabled && setActiveTab(item.id)}
                disabled={isDisabled}
                className={`w-full py-3 rounded-xl flex flex-col items-center justify-center gap-1.5 transition-all duration-200 ${
                  isDisabled
                    ? 'cursor-not-allowed text-[#6b7280]'
                    : isActive
                      ? 'bg-[#4E8981]/12 text-[#4E8981] shadow-[0_0_16px_rgba(78,137,129,0.08)] cursor-pointer'
                      : 'text-[#6b7280] hover:text-[#e5e2e1] hover:bg-white/[0.04] cursor-pointer'
                }`}
              >
                <IconComponent className="w-[22px] h-[22px]" />
                <span className={`text-[10px] font-semibold tracking-wide leading-none transition-colors duration-200 ${
                  isDisabled ? 'text-[#6b7280]' : isActive ? 'text-[#4E8981]' : 'text-[#6b7280] group-hover:text-[#e5e2e1]'
                }`}>
                  {item.label}
                </span>
              </button>
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
