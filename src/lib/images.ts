import { AppError } from './errors';
export function imagePath(value: string): string {
  if (!/^\/api\/v1\/(?:manga\/\d+\/thumbnail|extension\/icon\/[A-Za-z0-9_.-]+)$/.test(value))
    throw new AppError('VALIDATION_ERROR', 'Unsupported image path');
  return value;
}
export function proxyImage(value: string | null): string | null {
  return value ? `/api/suwayomi/image?path=${encodeURIComponent(imagePath(value))}` : null;
}
