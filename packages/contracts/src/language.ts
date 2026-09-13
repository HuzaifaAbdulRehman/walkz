import { z } from 'zod';

export const reviewLanguageIdSchema = z.enum([
  'javascript-typescript',
  'python',
]);

export type ReviewLanguageId = z.infer<typeof reviewLanguageIdSchema>;
