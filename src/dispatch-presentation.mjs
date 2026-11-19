// Display-only compatibility, derived from workflow bytes already read for admission.
// Older receivers must not receive undeclared inputs. No extra provider read is needed.
export function supportsTargetTitle(source) {
  return /^      target_repository: \{ required: false, type: string \}\r?$/m
    .test(source);
}

export function targetTitleInput(destination, repository) {
  return destination.targetTitle === true ? { target_repository: repository } : {};
}
