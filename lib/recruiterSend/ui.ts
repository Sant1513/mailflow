/** Status badge colours for Recruiter Bulk Send pages. */
export const STATUS_STYLE: Record<string, string> = {
  DRAFT: 'bg-muted text-muted-foreground',
  SCHEDULED: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200',
  SENDING: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100',
  PAUSED: 'bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-100',
  COMPLETED: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200',
  CANCELLED: 'bg-muted text-muted-foreground line-through',
};
