import { Card, CardContent } from "@/components/ui/card";

const SECTIONS = [
  {
    title: "Reprendre l'écoute",
    items: ["Cartier — Gazo", "MONTERO — Lil Nas X"],
  },
  { title: "Recommandé par l'IA", items: ["Rap FR", "Chill", "Workout"] },
  { title: "Tes playlists", items: ["Rap FR", "Chill", "Workout"] },
];

export default function Home() {
  return (
    <div className="mx-auto max-w-5xl space-y-8 py-6">
      <section>
        <h1 className="text-3xl font-bold tracking-tight">Bonjour</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Lecteur musical intelligent — recommandations par IA.
        </p>
      </section>

      {SECTIONS.map((section) => (
        <section key={section.title}>
          <h2 className="mb-4 text-xl font-semibold">{section.title}</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {section.items.map((item) => (
              <Card
                key={item}
                className="group bg-surface hover:bg-surface-hover cursor-pointer border-transparent p-4 transition-colors"
              >
                <CardContent className="space-y-3 p-0">
                  <div className="bg-surface-hover aspect-square w-full rounded-md" />
                  <p className="truncate text-sm font-medium">{item}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
