import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** 类名合并（shadcn 的做法）：`clsx` 处理条件，`twMerge` 处理 Tailwind 冲突。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
