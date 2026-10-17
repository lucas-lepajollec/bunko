import { z } from 'zod';
export const password = z.string().min(10).max(200);
export const credentials = z.strictObject({
  username: z
    .string()
    .min(3)
    .max(40)
    .regex(/^[A-Za-z0-9._-]+$/),
  password,
});
export const passwordChange = z.strictObject({ currentPassword: password, newPassword: password });
