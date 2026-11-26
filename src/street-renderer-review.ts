const options=typeof location==="undefined"?[]:
  (new URLSearchParams(location.search).get("rendererReview")??"").split(",");

export const rendererReview={
  opaque:options.includes("opaque"),
  shadows:options.includes("shadows"),
  lod:options.includes("lod"),
  occlusion:options.includes("occlusion"),
  foliageOcclusion:options.includes("foliageOcclusion"),
};
