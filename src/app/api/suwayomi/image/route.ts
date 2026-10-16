import { route } from '@/lib/api';
import { imagePath } from '@/lib/images';
import { getSettings } from '@/lib/settings';
import { suwayomiHeaders } from '@/lib/suwayomi';
import { endpoint } from '@/lib/http';
import { cachedImage, fetchImage, imageResponse, suwayomiImageKey } from '@/lib/image-cache';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = route(async (r) => {
  const relative = imagePath(new URL(r.url).searchParams.get('path') ?? '');
  const image = await cachedImage(suwayomiImageKey(relative), () =>
    fetchImage(
      endpoint(getSettings().suwayomiUrl, relative),
      suwayomiHeaders(),
      10 * 1024 * 1024,
      true,
    ),
  );
  return imageResponse(r, image);
});
