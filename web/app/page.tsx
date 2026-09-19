export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
      <h1 className="font-heading text-primary text-5xl font-bold tracking-tight">
        NeuroBeats
      </h1>
      <p className="text-muted-foreground max-w-md text-center">
        Lecteur musical intelligent — recommandations par IA.
      </p>
      <p className="text-muted-foreground/60 text-sm">
        Phase 0 : structure prête, UI à venir.
      </p>
    </main>
  );
}
