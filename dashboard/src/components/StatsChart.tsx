import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import type { StatsDay } from '../api';
import { useId } from '../a11y';
import { Button } from '@/components/ui/button';
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const chartConfig = {
  solved: { label: 'Solved', color: 'var(--chart-1)' },
  failed: { label: 'Failed', color: 'var(--chart-2)' },
} satisfies ChartConfig;

function shortDay(day: string): string {
  const [, m, d] = day.split('-');
  return `${m}/${d}`;
}

function longDay(day: string): string {
  return new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function summary(days: StatsDay[]): string {
  if (days.length === 0) return 'No data.';
  const solved = days.reduce((s, d) => s + d.solved, 0);
  const failed = days.reduce((s, d) => s + d.failed, 0);
  const peak = days.reduce((a, b) => (b.solved + b.failed > a.solved + a.failed ? b : a));
  return (
    `Stacked bar chart of solved and failed challenges per day, ${longDay(days[0].day)} to ` +
    `${longDay(days[days.length - 1].day)}. ${solved.toLocaleString()} solved and ${failed.toLocaleString()} failed in total. ` +
    `Busiest day ${longDay(peak.day)} with ${(peak.solved + peak.failed).toLocaleString()} attempts. ` +
    'Use “Show data table” for the daily numbers.'
  );
}

export default function StatsChart({ days }: { days: StatsDay[] }) {
  const [showTable, setShowTable] = useState(false);
  const tableId = useId('stats-table');

  return (
    <div className="grid gap-3">
      <div role="img" aria-label={summary(days)}>
        <ChartContainer config={chartConfig} className="aspect-auto h-64 w-full" aria-hidden="true">
          <BarChart accessibilityLayer data={days} margin={{ left: 0, right: 8 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={shortDay} />
            <YAxis tickLine={false} axisLine={false} width={32} allowDecimals={false} />
            <ChartTooltip content={<ChartTooltipContent labelFormatter={(v) => longDay(String(v))} />} />
            <ChartLegend content={<ChartLegendContent />} />
            <Bar dataKey="solved" stackId="a" fill="var(--color-solved)" radius={[0, 0, 4, 4]} />
            <Bar dataKey="failed" stackId="a" fill="var(--color-failed)" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ChartContainer>
      </div>
      <div>
        <Button
          type="button"
          variant="link"
          className="px-0"
          aria-expanded={showTable}
          aria-controls={tableId}
          onClick={() => setShowTable((v) => !v)}
        >
          {showTable ? 'Hide data table' : 'Show data table'}
        </Button>
      </div>
      <div id={tableId} hidden={!showTable} className="max-h-80 overflow-auto rounded-md border">
        <Table>
          <TableCaption className="sr-only">Daily challenge results</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Day</TableHead>
              <TableHead className="text-right">Issued</TableHead>
              <TableHead className="text-right">Solved</TableHead>
              <TableHead className="text-right">Failed</TableHead>
              <TableHead className="text-right">Interactive</TableHead>
              <TableHead className="text-right">Verified</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {days.map((d) => (
              <TableRow key={d.day}>
                <TableCell className="font-medium">{longDay(d.day)}</TableCell>
                <TableCell className="text-right tabular-nums">{d.issued.toLocaleString()}</TableCell>
                <TableCell className="text-right tabular-nums">{d.solved.toLocaleString()}</TableCell>
                <TableCell className="text-right tabular-nums">{d.failed.toLocaleString()}</TableCell>
                <TableCell className="text-right tabular-nums">{d.interactive.toLocaleString()}</TableCell>
                <TableCell className="text-right tabular-nums">{d.verified.toLocaleString()}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
