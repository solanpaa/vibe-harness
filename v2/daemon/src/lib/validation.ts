// ---------------------------------------------------------------------------
// Input validation utilities (CDD §2.1)
// ---------------------------------------------------------------------------

import path from 'node:path';
import { InvalidGitRefError, PathTraversalError } from './errors.js';

/** Allowed characters in git refs: alphanumeric, dot, underscore, hyphen, slash */
const SAFE_REF_PATTERN = /^[a-zA-Z0-9._/-]+$/;

/** Characters explicitly blocked in any shell-adjacent input */
const BLOCKED_CHARS = /[`$;|<>(){}\\\n]/;

/** Double-dot traversal blocked in git refs */
const DOUBLE_DOT = /\.\./;

/**
 * Validates a git ref (branch name, tag) is safe for shell use.
 * Throws InvalidGitRefError if the ref contains dangerous characters.
 */
export function assertSafeRef(ref: string, label = 'ref'): void {
  if (!ref || ref.trim().length === 0) {
    throw new InvalidGitRefError(`${label} must not be empty`);
  }
  if (ref.startsWith('-')) {
    throw new InvalidGitRefError(`${label} must not start with '-'`);
  }
  if (DOUBLE_DOT.test(ref)) {
    throw new InvalidGitRefError(`${label} must not contain '..'`);
  }
  if (BLOCKED_CHARS.test(ref)) {
    throw new InvalidGitRefError(
      `${label} contains disallowed characters: ${ref}`,
    );
  }
  if (!SAFE_REF_PATTERN.test(ref)) {
    throw new InvalidGitRefError(
      `${label} contains invalid characters (allowed: a-z A-Z 0-9 . _ / -): ${ref}`,
    );
  }
}

/**
 * Validates a file path is within the expected base directory.
 * Prevents path traversal attacks.
 */
export function assertSafePath(filePath: string, basePath: string): void {
  const resolved = path.resolve(basePath, filePath);
  if (!resolved.startsWith(path.resolve(basePath))) {
    throw new PathTraversalError(
      `Path ${filePath} escapes base directory ${basePath}`,
    );
  }
}
