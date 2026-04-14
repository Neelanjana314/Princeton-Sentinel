function isTruthy(value: string | undefined) {
  if (!value) {
    return false;
  }

  return ["1", "true", "t", "yes", "y", "on"].includes(value.trim().toLowerCase());
}

export function isLocalDockerDeployment() {
  return isTruthy(process.env.LOCAL_DOCKER_DEPLOYMENT);
}
