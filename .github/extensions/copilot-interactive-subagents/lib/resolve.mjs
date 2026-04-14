import {
  createStateStore as defaultCreateStateStore,
} from "./state.mjs";
import { createStateIndex as defaultCreateStateIndex } from "./state-index.mjs";

export function resolveOperation({ request, services = {}, name }) {
  return request[name] ?? services[name];
}

export function resolveStateStore({ request, services = {} }) {
  if (request.stateStore) {
    return request.stateStore;
  }

  if (services.stateStore) {
    return services.stateStore;
  }

  const createStateStore = request.createStateStore ?? services.createStateStore ?? defaultCreateStateStore;
  return createStateStore({
    workspacePath: request.workspacePath,
    projectRoot: request.projectRoot,
  });
}

export function resolveStateIndex({ request = {}, services = {} }) {
  if (request.stateIndex) {
    return request.stateIndex;
  }

  if (services.stateIndex) {
    return services.stateIndex;
  }

  if (!request.projectRoot && !request.createStateIndex && !services.createStateIndex) {
    return null;
  }

  const createStateIndex = request.createStateIndex ?? services.createStateIndex ?? defaultCreateStateIndex;
  return createStateIndex({
    projectRoot: request.projectRoot,
  });
}
