// @sharedid-edge/aws-lambda/edge: SharedID Edge on Lambda@Edge, answering a CloudFront behaviour from an
// origin-request or viewer-request function that generates the response. See README.md, Lambda@Edge.
export type { CloudFrontHeaders, CloudFrontRequest, CloudFrontRequestEvent, CloudFrontResultResponse } from './edge-event.js';
export { createEdgeHandler, edgeInternalError, edgePlatformInfo, type EdgeEventType, type EdgeHandler, type EdgeHandlerOptions, type GdprWithoutLocation } from './edge-handler.js';
export { edgeHandlerFromBuild, edgeHandlerFromText, edgeOptions, parseEdgeBuild, type EdgeBuild } from './edge-env.js';
export { builtInModules } from '@sharedid-edge/modules';
