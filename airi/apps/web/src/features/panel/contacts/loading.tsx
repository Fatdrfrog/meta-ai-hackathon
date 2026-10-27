import { CustomerPipelineBoardSkeleton } from "@/components/customers/customer-pipeline-board-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

export default function LoadingContacts() {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-x-hidden px-3 pb-2 pt-3 sm:px-4 lg:px-5">
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        {/* Same one-row toolbar as the loaded page: title, view, queues, search. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-8 w-20 lg:w-52" />
          <Skeleton className="order-last h-8 w-full max-w-[26rem] md:order-none md:w-[26rem]" />
          <div className="ml-auto flex items-center gap-2 max-sm:w-full">
            <Skeleton className="h-8 flex-1 sm:w-64 sm:flex-none" />
            <Skeleton className="h-8 w-24" />
          </div>
        </div>

        <CustomerPipelineBoardSkeleton />
      </div>
    </div>
  );
}
