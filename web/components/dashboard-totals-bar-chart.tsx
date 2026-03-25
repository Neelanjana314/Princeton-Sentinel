"use client";

import { Bar } from "react-chartjs-2";
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend } from "chart.js";
import { useRouter } from "next/navigation";
import { barColors, commonBarOptions, numberLabel } from "@/components/chart-config";

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend);

export function DashboardTotalsBarChart({
  totals,
}: {
  totals: { sites: number; users: number; groups: number; drives: number };
}) {
  const router = useRouter();
  const labels = ["SharePoint Sites", "Active Users", "Groups", "Drives"];
  const pageLinks = ["/dashboard/sites", "/dashboard/users", "/dashboard/groups", null];
  const data = {
    labels,
    datasets: [
      {
        label: "Totals",
        data: [totals.sites, totals.users, totals.groups, totals.drives],
        ...barColors("primary"),
        borderWidth: 1,
        borderRadius: 6,
      },
    ],
  };
  const options = {
    ...commonBarOptions("y"),
    onClick: (_event: any, elements: any[]) => {
      if (elements && elements.length > 0) {
        const barIndex = elements[0].index;
        const href = pageLinks[barIndex];
        if (href) {
          router.push(href);
        }
      }
    },
    plugins: {
      ...commonBarOptions("y").plugins,
      tooltip: {
        ...commonBarOptions("y").plugins?.tooltip,
        callbacks: {
          label: (ctx: any) => `${labels[ctx.dataIndex]}: ${numberLabel(ctx.parsed.x ?? 0)}`,
        },
      },
    },
    scales: { ...commonBarOptions("y").scales, x: { ...commonBarOptions("y").scales?.x, beginAtZero: true, title: { display: true, text: "Count" } } },
  };
  return (
    <div className="flex h-56 w-full cursor-pointer items-center justify-center">
      <Bar data={data} options={options} />
    </div>
  );
}
