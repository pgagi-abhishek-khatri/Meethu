export interface ValidationResult {
  valid: boolean;
  kind?: "question" | "sentence";
  formattedText?: string;
  reason?: "empty" | "too_short" | "filler_only" | "irrelevant" | "incomplete" | "incorrect_structure";
  message?: string;
}

export interface ValidationOptions {
  minWords?: number;
}

export function validateUserInput(rawText: string, options?: ValidationOptions): ValidationResult;
export const BACKCHANNEL: RegExp;
export const QUESTION_WORDS: RegExp;
export const DANGLING_CONJUNCTION: RegExp;
