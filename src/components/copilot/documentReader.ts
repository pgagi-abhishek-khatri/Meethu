// Document reader utility for user-attached files in the Copilot Composer.
// Extracts clean textual content and metadata for prompt context injection.

export interface AttachedDocument {
  name: string;
  size: number;
  type: string;
  content: string;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/**
 * Reads text content from a user-uploaded File object.
 * Truncates safely to 100,000 characters to avoid overflowing model context budgets.
 */
export async function readAttachedFile(file: File): Promise<AttachedDocument> {
  const text = await file.text();
  return {
    name: file.name,
    size: file.size,
    type: file.type || "text/plain",
    content: text.slice(0, 100000),
  };
}
