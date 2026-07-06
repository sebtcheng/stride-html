// stride-assets.js
(function () {
  const csvFiles = [
    "all_deped_summary_april2026.csv",
    "efd_classroom_july2026.csv",
    "enrolment_sy2025-2026.csv",
    "insighted_classes_organized.csv",
    "insighted_classroom_conditions.csv",
    "insighted_classroom_repairs.csv",
    "insighted_electrical_safety.csv",
    "insighted_furniture.csv",
    "insighted_gadgets.csv",
    "insighted_infra_summary.csv",
    "insighted_safety_equipment.csv",
    "insighted_school_info.csv",
    "insighted_shifting.csv",
    "insighted_utilities.csv",
    "insighted_wash.csv",
    "ph_schools_20260616410.csv",
    "sdo_classification_202606151013.csv",
    "stride_school_unique.csv"
  ];

  const pngFiles = [
    "bagong_pilipinas.png",
    "deped_logo.png",
    "hrod_logo.png",
    "insighted_logo_horizontal.png",
    "insighted_logo_vertical.png",
    "Screenshot_34.png",
    "Screenshot_35.png",
    "Screenshot_36.png"
  ];

  const insightedCsvFiles = csvFiles.filter(file => /^insighted_.+\.csv$/i.test(file));
  const screenshotFiles = pngFiles.filter(file => /^Screenshot.+\.png$/i.test(file));
  const logoFiles = pngFiles.filter(file => /logo|bagong_pilipinas/i.test(file));

  window.STRIDE_ASSETS = {
    csvFiles,
    pngFiles,
    insightedCsvFiles,
    screenshotFiles,
    logoFiles,

    csvUrls: csvFiles.map(file => "./" + file),
    pngUrls: pngFiles.map(file => "./" + file),
    insightedCsvUrls: insightedCsvFiles.map(file => "./" + file),
    screenshotUrls: screenshotFiles.map(file => "./" + file),
    logoUrls: logoFiles.map(file => "./" + file)
  };
})();