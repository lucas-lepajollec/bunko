import { z } from 'zod';
import { PASSWORD_MAX, PASSWORD_MIN, USERNAME_PATTERN } from '@/domain/account-rules';
export const password = z.string().min(PASSWORD_MIN).max(PASSWORD_MAX);
export const credentials = z.strictObject({
  username: z.string().regex(USERNAME_PATTERN),
  password,
});
export const passwordChange = z.strictObject({ currentPassword: password, newPassword: password });
