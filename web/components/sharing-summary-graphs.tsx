"use client";
import { Bar, Pie } from "react-chartjs-2";
import { Chart as ChartJS, CategoryScale, LinearScale, BarElement, ArcElement, Title, Tooltip, Legend } from "chart.js";
import { useRouter } from "next/navigation";
import { barColors, commonBarOptions, commonPieOptions, labelLimit, numberLabel, pieColors } from "@/components/chart-config";
import { cn } from "@/lib/utils";

ChartJS.register(CategoryScale, LinearScale, BarElement, ArcElement, Title, Tooltip, Legend);

export function SharingSummaryBarChart({
  data,
  label,
  xTitle,
  href,
}: {
  data: { label: string; value: number; href?: string }[];
  label: string;
  xTitle: string;
  href?: string;
}) {
  const router = useRouter();
  const barData = {
    labels: data.map((d) => labelLimit(d.label)),
    datasets: [
      {
        label,
        data: data.map((d) => d.value),
        ...barColors("primary"),
        borderWidth: 1,
        borderRadius: 6,
      },
    ],
  };
  const baseOptions: any = commonBarOptions("y");
  const barOptions = {
    ...baseOptions,
    onClick: (_event: unknown, elements: { index: number }[]) => {
      if (elements.length > 0) {
        const targetHref = data[elements[0].index]?.href ?? href;
        if (targetHref) {
          router.push(targetHref);
        }
      }
    },
    plugins: {
      ...baseOptions.plugins,
      tooltip: { ...baseOptions.plugins?.tooltip, callbacks: { label: (ctx: any) => `${ctx.dataset.label}: ${numberLabel(ctx.parsed.x ?? 0)}` } },
    },
    scales: {
      ...baseOptions.scales,
      x: { ...baseOptions.scales?.x, beginAtZero: true, title: { display: true, text: xTitle } },
      y: {
        ...baseOptions.scales?.y,
        ticks: {
          autoSkip: false,
          callback: function (_value: any, index: number) {
            return barData.labels[index];
          },
        },
      },
    },
  };
  return (
    <div className={cn("h-full w-full", href || data.some((d) => d.href) ? "cursor-pointer" : undefined)}>
      <Bar data={barData} options={barOptions} />
    </div>
  );
}

export function SharingSummaryPieChart({ data, href }: { data: { label: string; value: number; href?: string }[]; href?: string }) {
  const router = useRouter();
  const colors = pieColors();
  const pieOptions = {
    ...commonPieOptions(),
    onClick: (_event: unknown, elements: { index: number }[]) => {
      if (elements.length > 0) {
        const targetHref = data[elements[0].index]?.href ?? href;
        if (targetHref) {
          router.push(targetHref);
        }
      }
    },
  };
  return (
    <div
      className={cn(
        "ps-chart-legend-scroll w-full min-w-0",
        href || data.some((d) => d.href) ? "cursor-pointer" : undefined
      )}
    >
      <div className="w-full min-w-0">
        <Pie
          data={{
            labels: data.map((d) => d.label),
            datasets: [
              {
                label: "Links",
                data: data.map((d) => d.value),
                backgroundColor: colors,
              },
            ],
          }}
          options={pieOptions}
          height={260}
        />
      </div>
    </div>
  );
}
