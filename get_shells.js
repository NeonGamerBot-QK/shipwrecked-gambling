const { Client } = require("pg");

const client = new Client(process.env.SHIPWRECKED_PSQL_URL);

async function getProjectHackatimeHours(project) {
  if (!project) return 0;

  if (project.hackatimeLinks && project.hackatimeLinks.length > 0) {
    return project.hackatimeLinks.reduce((sum, link) => {
      const effectiveHours =
        link.hoursOverride !== undefined && link.hoursOverride !== null
          ? link.hoursOverride
          : typeof link.rawHours === "number"
            ? link.rawHours
            : 0;
      return sum + effectiveHours;
    }, 0);
  }

  // Fallback - if no hackatime links, return 0 as there's no rawHours field in Project table
  return 0;
}

async function getProjectApprovedHours(project) {
  if (!project) return 0;

  if (project.hackatimeLinks && project.hackatimeLinks.length > 0) {
    return project.hackatimeLinks.reduce((sum, link) => {
      if (link.hoursOverride !== undefined && link.hoursOverride !== null) {
        return sum + link.hoursOverride;
      }
      return sum;
    }, 0);
  }

  // No hoursOverride field in Project table either
  return 0;
}

async function calculateProgressMetricsByEmail(userEmail) {
  await client.connect();

  // Fetch user data including purchased hours and shell adjustments
  const userRes = await client.query(
    'SELECT "purchasedProgressHours", "totalShellsSpent", "adminShellAdjustment" FROM "User" WHERE email = $1',
    [userEmail],
  );

  let purchasedProgressHours = 0;
  let totalShellsSpent = 0;
  let adminShellAdjustment = 0;

  if (userRes.rows.length > 0) {
    const userData = userRes.rows[0];
    purchasedProgressHours = userData.purchasedProgressHours || 0;
    totalShellsSpent = userData.totalShellsSpent || 0;
    adminShellAdjustment = userData.adminShellAdjustment || 0;
  }

  const res = await client.query(
    `
        SELECT 
            p."projectID",
            p.name,
            p.description,
            p."codeUrl",
            p."playableUrl",
            p.screenshot,
            p.submitted,
            p."userId",
            p.shipped,
            p.viral,
            COALESCE(
                json_agg(
                    json_build_object(
                        'hoursOverride', hl."hoursOverride",
                        'rawHours', hl."rawHours"
                    )
                ) FILTER (WHERE hl.id IS NOT NULL),
                '[]'
            ) AS "hackatimeLinks"
        FROM "Project" p
        INNER JOIN "User" u ON u.id = p."userId"
        LEFT JOIN "HackatimeProjectLink" hl ON hl."projectID" = p."projectID"
        WHERE u.email = $1
        GROUP BY p."projectID", p.name, p.description, p."codeUrl", p."playableUrl", p.screenshot, p.submitted, p."userId", p.shipped, p.viral
        `,
    [userEmail],
  );

  const projects = res.rows;

  if (!projects.length) {
    await client.end();
    return {
      shippedHours: 0,
      viralHours: 0,
      otherHours: 0,
      totalHours: 0,
      totalPercentage: 0,
      rawHours: 0,
      availableShells: 0,
      purchasedProgressHours,
      totalProgressWithPurchased: purchasedProgressHours,
      totalPercentageWithPurchased: Math.min(purchasedProgressHours, 100),
    };
  }

  let shippedHours = 0;
  let viralHours = 0;
  let otherHours = 0;
  let rawHours = 0;
  let availableShells = 0;

  const allProjectsWithHours = await Promise.all(
    projects.map(async (project) => ({
      project,
      hours: await getProjectHackatimeHours(project),
    })),
  );

  allProjectsWithHours.sort((a, b) => b.hours - a.hours);

  const top4Projects = allProjectsWithHours.slice(0, 4);

  for (const { project, hours } of top4Projects) {
    let cappedHours = Math.min(hours, 15);
    const approvedHours = await getProjectApprovedHours(project);

    if (project.viral === true && approvedHours > 0) {
      viralHours += cappedHours;
    } else if (project.shipped === true && approvedHours > 0) {
      shippedHours += cappedHours;
    } else {
      otherHours += Math.min(cappedHours, 14.75);
    }
  }

  const phi = (1 + Math.sqrt(5)) / 2;
  const top4ProjectIds = new Set(
    top4Projects.map(({ project }) => project.projectID),
  );

  for (const { project, hours } of allProjectsWithHours) {
    rawHours += hours;

    if (project.shipped === true) {
      const approvedHours = await getProjectApprovedHours(project);

      if (approvedHours > 0) {
        if (top4ProjectIds.has(project.projectID)) {
          if (approvedHours > 15) {
            availableShells += (approvedHours - 15) * (phi * 10);
          }
        } else {
          availableShells += approvedHours * (phi * 10);
        }
      }
    }
  }

  const totalHours = Math.min(shippedHours + viralHours + otherHours, 60);
  const totalPercentage = Math.min((totalHours / 60) * 100, 100);

  const totalProgressWithPurchased = Math.min(
    totalHours + purchasedProgressHours * 0.6,
    60,
  );
  const totalPercentageWithPurchased = Math.min(
    totalPercentage + purchasedProgressHours,
    100,
  );

  const finalAvailableShells = Math.max(
    0,
    Math.floor(availableShells) - totalShellsSpent + adminShellAdjustment,
  );

  await client.end();

  return {
    shippedHours,
    viralHours,
    otherHours,
    totalHours,
    totalPercentage,
    rawHours,
    availableShells: finalAvailableShells,
    purchasedProgressHours,
    totalProgressWithPurchased,
    totalPercentageWithPurchased,
  };
}

module.exports = { calculateProgressMetricsByEmail };
