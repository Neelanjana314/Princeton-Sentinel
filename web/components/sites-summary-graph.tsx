"use client";

import { Bar } from "react-chartjs-2";
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend } from "chart.js";
import ChartCard from "@/components/chart-card";
import { barColors, commonBarOptions, numberLabel } from "@/components/chart-config";

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend);

type Point = { label: string; value: number };

export type SitesSummaryGraphProps = {
  createdByMonth: Point[];
  activityRecencyBuckets: Point[];
};

export function SitesSummaryGraph({ createdByMonth, activityRecencyBuckets }: SitesSummaryGraphProps) {
  const createdBarData = {
    labels: createdByMonth.map((p) => p.label),
    datasets: [
      {
        label: "SharePoint sites created",
        data: createdByMonth.map((p) => p.value),
        ...barColors("primary"),
        borderWidth: 1,
        borderRadius: 6,
      },
    ],
  };
  const recencyBarData = {
    labels: activityRecencyBuckets.map((p) => p.label),
    datasets: [
      {
        label: "SharePoint sites",
        data: activityRecencyBuckets.map((p) => p.value),
        ...barColors("primary"),
        borderWidth: 1,
        borderRadius: 6,
      },
    ],
  };

  const baseBarOptions: any = commonBarOptions("x");
  const createdBarOptions = {
    ...baseBarOptions,
    plugins: {
      ...baseBarOptions.plugins,
      tooltip: { ...baseBarOptions.plugins?.tooltip, callbacks: { label: (ctx: any) => `${ctx.dataset.label}: ${numberLabel(ctx.parsed.y ?? 0)}` } },
    },
    scales: {
      ...baseBarOptions.scales,
      x: {
        ...baseBarOptions.scales?.x,
        ticks: {
          maxRotation: 45,
          minRotation: 0,
          autoSkip: true,
          maxTicksLimit: 12,
        },
      },
      y: { ...baseBarOptions.scales?.y, beginAtZero: true, title: { display: true, text: "Sites" } },
    },
  };
  const recencyBarOptions = {
    ...baseBarOptions,
    plugins: {
      ...baseBarOptions.plugins,
      tooltip: { ...baseBarOptions.plugins?.tooltip, callbacks: { label: (ctx: any) => `${ctx.dataset.label}: ${numberLabel(ctx.parsed.y ?? 0)}` } },
    },
    scales: {
      ...baseBarOptions.scales,
      x: {
        ...baseBarOptions.scales?.x,
        ticks: {
          maxRotation: 0,
          minRotation: 0,
          autoSkip: false,
        },
      },
      y: { ...baseBarOptions.scales?.y, beginAtZero: true, title: { display: true, text: "Sites" } },
    },
  };

  return (
    <div className="grid w-full grid-cols-1 gap-6 md:grid-cols-2">
      <ChartCard title="SharePoint Sites Created Over Time">
        <Bar data={createdBarData} options={createdBarOptions} />
      </ChartCard>
      <ChartCard title="SharePoint Sites by Last Activity">
        <Bar data={recencyBarData} options={recencyBarOptions} />
      </ChartCard>
    </div>
  );
}
