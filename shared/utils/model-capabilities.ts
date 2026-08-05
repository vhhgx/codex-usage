const imageEndpoints = new Set(['/v1/images/generations', '/v1/images/edits'])
const imageModelFamily = /(?:^|[-_.:/])(?:gpt[-_.]?image|image(?:gen|generation)?|dall[-_.]?e|imagen|flux|recraft|ideogram|stable[-_.]?diffusion)(?:$|[-_.:/])/i

export function supportsImagePricing(publicModel: string, endpointGroups: readonly (readonly string[])[]) {
  if (endpointGroups.some(endpoints => endpoints.some(endpoint => imageEndpoints.has(endpoint)))) return true
  return endpointGroups.some(endpoints => endpoints.length === 0) && imageModelFamily.test(publicModel)
}
