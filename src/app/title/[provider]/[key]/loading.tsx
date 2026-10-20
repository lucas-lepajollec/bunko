import { Skeleton } from '@/components/ui';

export default function Loading() {
  return (
    <main
      aria-busy="true"
      className="mx-auto flex max-w-[1760px] flex-col gap-4 px-4 pt-[300px] md:flex-row md:items-end md:gap-12 md:px-10 md:pt-[220px]"
    >
      <Skeleton className="aspect-[2/3] w-28 md:w-[250px]" />
      <div className="flex flex-1 flex-col gap-4">
        <Skeleton className="h-3 w-56" />
        <Skeleton className="h-14 w-3/4 md:h-20" />
        <Skeleton className="h-6 w-1/2" />
      </div>
    </main>
  );
}
