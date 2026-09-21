import type { Metadata } from "next";
import { BarChart3, Clock, Music2, SkipForward, User } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";

export const metadata: Metadata = { title: "Statistiques — NeuroBeats" };

const STATS = [
  { icon: Music2, label: "Titres écoutés", value: "—" },
  { icon: User, label: "Artiste préféré", value: "—" },
  { icon: Clock, label: "Créneau favori", value: "—" },
  { icon: SkipForward, label: "Taux de skip", value: "—" },
];

export default function StatsPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-8 py-6">
      <div className="flex items-center gap-3">
        <BarChart3 className="text-primary size-7" />
        <h1 className="text-3xl font-bold tracking-tight">Statistiques</h1>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {STATS.map(({ icon: Icon, label, value }) => (
          <Card key={label} className="bg-surface border-transparent p-5">
            <CardContent className="space-y-2 p-0">
              <Icon className="text-muted-foreground size-5" />
              <p className="text-2xl font-bold tabular-nums">{value}</p>
              <p className="text-muted-foreground text-xs">{label}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <section>
        <h2 className="mb-4 text-lg font-semibold">Top artistes</h2>
        <div className="text-muted-foreground bg-surface rounded-lg p-8 text-center text-sm">
          Les statistiques s&apos;afficheront après quelques écoutes.
        </div>
      </section>
    </div>
  );
}
