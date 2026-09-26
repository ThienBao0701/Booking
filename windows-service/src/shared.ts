/**
 * Single point of coupling to @lab/shared. The rest of the service imports
 * contracts/safety/redaction from here. When workspace linking is set up, this
 * can be repointed at the package name "@lab/shared" without touching callers.
 */
export * from "../../shared/src/index.ts";
