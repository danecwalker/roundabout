import type { ReactNode } from 'react';
import { Tabs as UiTabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export interface TabDef {
  key: string;
  label: string;
  content: ReactNode;
}

/** Thin wrapper keeping the old call-site API on top of shadcn Tabs (Radix: full ARIA tabs pattern). */
export default function Tabs({ label, tabs }: { label: string; idPrefix?: string; tabs: TabDef[] }) {
  return (
    <UiTabs defaultValue={tabs[0]?.key} className="min-w-0">
      <div className="overflow-x-auto">
        <TabsList aria-label={label}>
          {tabs.map((t) => (
            <TabsTrigger key={t.key} value={t.key}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {tabs.map((t) => (
        <TabsContent key={t.key} value={t.key} className="grid min-w-0 gap-4 pt-2">
          {t.content}
        </TabsContent>
      ))}
    </UiTabs>
  );
}
