'use client';

import React from 'react';
import { useApp } from './context';
import Marketplace from './marketplace';
import ExecutionPanel from './execution';
import Billing from './billing';
import MyAgents from './my-agents';
import Workflows from './workflows';

export default function Workspace() {
  const { activeTab } = useApp();

  return (
    <div className="flex-1 w-full py-4">
      {activeTab === 'marketplace' && <Marketplace />}
      {activeTab === 'my-agents' && <MyAgents />}
      {activeTab === 'workflows' && <Workflows />}
      {activeTab === 'billing' && <Billing />}
    </div>
  );
}
