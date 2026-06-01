import { getGaminCNClient } from './utils/garmin_cn';
import { getGaminGlobalClient } from './utils/garmin_global';
import { downloadGarminActivity, uploadGarminActivity } from './utils/garmin_common';

type Activity = Record<string, any>;

type MatchedActivity = {
    cnActivity: Activity;
    globalActivity: Activity;
    distanceDiffMeters: number;
    durationDiffSeconds: number;
};

type CompareResult = {
    cnActivities: Activity[];
    globalActivities: Activity[];
    missingInGlobal: Activity[];
    suspiciousMatches: MatchedActivity[];
    fuzzyMatches: MatchedActivity[];
};

const DEFAULT_LIMIT = 500;
const DEFAULT_DISTANCE_TOLERANCE_METERS = 200;
const DEFAULT_DURATION_TOLERANCE_SECONDS = 180;
const PAGE_SIZE = 100;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const getNumberEnv = (name: string, fallback: number): number => {
    const value = process.env[name];
    if (!value) {
        return fallback;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`${name} must be a non-negative number`);
    }
    return parsed;
};

const getStringEnv = (name: string): string | undefined => {
    const value = process.env[name]?.trim();
    return value ? value : undefined;
};

const getMode = (): 'audit' | 'backfill' => {
    const mode = getStringEnv('GARMIN_BACKFILL_MODE') ?? 'audit';
    if (mode !== 'audit' && mode !== 'backfill') {
        throw new Error('GARMIN_BACKFILL_MODE must be audit or backfill');
    }
    return mode;
};

const formatDay = (date: Date): string => date.toISOString().slice(0, 10);

const parseLocalDate = (dateText: string | undefined, endOfDay = false): Date | undefined => {
    if (!dateText) {
        return undefined;
    }
    const match = dateText.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
        throw new Error(`Date must use YYYY-MM-DD: ${dateText}`);
    }
    const [, year, month, day] = match;
    const suffix = endOfDay ? 'T23:59:59' : 'T00:00:00';
    return new Date(`${year}-${month}-${day}${suffix}`);
};

const getStartTime = (activity: Activity): string => activity.startTimeLocal ?? '';

const getActivityType = (activity: Activity): string => activity.activityType?.typeKey ?? '';

const getActivityDate = (activity: Activity): string => getStartTime(activity).slice(0, 10);

const getActivityCategory = (activity: Activity): string => {
    const typeKey = getActivityType(activity);
    if (typeKey.includes('running')) {
        return 'running';
    }
    if (typeKey.includes('cycling') || typeKey.includes('biking')) {
        return 'cycling';
    }
    if (typeKey.includes('cardio')) {
        return 'cardio';
    }
    if (typeKey.includes('strength')) {
        return 'strength';
    }
    return typeKey;
};

const getDistance = (activity: Activity): number => Number(activity.distance ?? 0);

const getDuration = (activity: Activity): number => Number(activity.duration ?? activity.elapsedDuration ?? 0);

const getActivityKey = (activity: Activity): string => `${getStartTime(activity)}|${getActivityType(activity)}`;

const getDistanceTolerance = (activity: Activity): number => Math.max(DEFAULT_DISTANCE_TOLERANCE_METERS, getDistance(activity) * 0.01);

const getDurationTolerance = (activity: Activity): number => Math.max(DEFAULT_DURATION_TOLERANCE_SECONDS, getDuration(activity) * 0.02);

const maskActivityId = (activityId: unknown): string => {
    const value = String(activityId ?? '');
    if (value.length <= 6) {
        return value ? '***' : '';
    }
    return `${value.slice(0, 3)}***${value.slice(-3)}`;
};

const summarizeActivity = (activity: Activity): string => {
    const distanceKm = getDistance(activity) / 1000;
    const durationMin = getDuration(activity) / 60;
    return [
        getStartTime(activity),
        getActivityType(activity),
        `${distanceKm.toFixed(2)}km`,
        `${durationMin.toFixed(1)}min`,
        `id=${maskActivityId(activity.activityId)}`,
    ].join(' | ');
};

const getOldestAllowedDate = (startDate?: Date): Date | undefined => {
    const outageStart = parseLocalDate(getStringEnv('GARMIN_OUTAGE_START'));
    if (startDate && outageStart) {
        return startDate < outageStart ? startDate : outageStart;
    }
    return startDate ?? outageStart;
};

const isBeforeOldestAllowedDate = (activity: Activity, oldestAllowedDate?: Date): boolean => {
    if (!oldestAllowedDate) {
        return false;
    }
    const startTime = getStartTime(activity);
    if (!startTime) {
        return false;
    }
    return new Date(startTime).getTime() < oldestAllowedDate.getTime() - ONE_DAY_MS;
};

const isInDateWindow = (activity: Activity, startDate?: Date, endDate?: Date): boolean => {
    const startTime = getStartTime(activity);
    if (!startTime) {
        return false;
    }
    const activityDate = new Date(startTime);
    if (Number.isNaN(activityDate.getTime())) {
        return false;
    }
    if (startDate && activityDate < startDate) {
        return false;
    }
    if (endDate && activityDate > endDate) {
        return false;
    }
    return true;
};

const fetchActivities = async (
    client: any,
    limit: number,
    oldestAllowedDate?: Date,
): Promise<Activity[]> => {
    const activities: Activity[] = [];
    let start = 0;

    while (activities.length < limit) {
        const batchSize = Math.min(PAGE_SIZE, limit - activities.length);
        const batch = await client.getActivities(start, batchSize);
        if (!batch?.length) {
            break;
        }
        activities.push(...batch);
        if (batch.length < batchSize) {
            break;
        }
        if (batch.some((activity: Activity) => isBeforeOldestAllowedDate(activity, oldestAllowedDate))) {
            break;
        }
        start += batch.length;
    }

    return activities.slice(0, limit);
};

const findMissingActivities = (
    cnActivities: Activity[],
    globalActivities: Activity[],
    startDate?: Date,
    endDate?: Date,
): CompareResult => {
    const globalByKey = new Map<string, Activity>();
    globalActivities.forEach((activity) => {
        globalByKey.set(getActivityKey(activity), activity);
    });

    const missingInGlobal: Activity[] = [];
    const suspiciousMatches: MatchedActivity[] = [];
    const fuzzyMatches: MatchedActivity[] = [];

    const findFuzzyMatch = (cnActivity: Activity): MatchedActivity | undefined => {
        const candidates = globalActivities
            .filter((globalActivity) => getActivityDate(globalActivity) === getActivityDate(cnActivity))
            .filter((globalActivity) => getActivityCategory(globalActivity) === getActivityCategory(cnActivity))
            .map((globalActivity) => {
                const distanceDiffMeters = Math.abs(getDistance(cnActivity) - getDistance(globalActivity));
                const durationDiffSeconds = Math.abs(getDuration(cnActivity) - getDuration(globalActivity));
                return { cnActivity, globalActivity, distanceDiffMeters, durationDiffSeconds };
            })
            .filter((match) => (
                match.distanceDiffMeters <= getDistanceTolerance(cnActivity) &&
                match.durationDiffSeconds <= getDurationTolerance(cnActivity)
            ))
            .sort((a, b) => (
                (a.distanceDiffMeters + a.durationDiffSeconds) -
                (b.distanceDiffMeters + b.durationDiffSeconds)
            ));

        return candidates[0];
    };

    cnActivities
        .filter((activity) => isInDateWindow(activity, startDate, endDate))
        .forEach((cnActivity) => {
            const globalActivity = globalByKey.get(getActivityKey(cnActivity));
            if (!globalActivity) {
                const fuzzyMatch = findFuzzyMatch(cnActivity);
                if (fuzzyMatch) {
                    fuzzyMatches.push(fuzzyMatch);
                    return;
                }
                missingInGlobal.push(cnActivity);
                return;
            }

            const distanceDiffMeters = Math.abs(getDistance(cnActivity) - getDistance(globalActivity));
            const durationDiffSeconds = Math.abs(getDuration(cnActivity) - getDuration(globalActivity));
            if (
                distanceDiffMeters > DEFAULT_DISTANCE_TOLERANCE_METERS ||
                durationDiffSeconds > DEFAULT_DURATION_TOLERANCE_SECONDS
            ) {
                suspiciousMatches.push({ cnActivity, globalActivity, distanceDiffMeters, durationDiffSeconds });
            }
        });

    return { cnActivities, globalActivities, missingInGlobal, suspiciousMatches, fuzzyMatches };
};

const printCompareResult = (result: CompareResult, backfillLimit: number) => {
    console.log(`CN activities fetched: ${result.cnActivities.length}`);
    console.log(`Global activities fetched: ${result.globalActivities.length}`);
    console.log(`Missing in Global: ${result.missingInGlobal.length}`);
    console.log(`Fuzzy matches: ${result.fuzzyMatches.length}`);
    console.log(`Suspicious matches: ${result.suspiciousMatches.length}`);

    result.missingInGlobal.slice(0, backfillLimit).forEach((activity, index) => {
        console.log(`MISSING[${index + 1}]: ${summarizeActivity(activity)}`);
    });

    if (result.missingInGlobal.length > backfillLimit) {
        console.log(`Missing list truncated to backfill limit ${backfillLimit}`);
    }

    result.suspiciousMatches.slice(0, 20).forEach((match, index) => {
        console.log(
            `SUSPICIOUS[${index + 1}]: ${summarizeActivity(match.cnActivity)} | ` +
            `distanceDiff=${match.distanceDiffMeters.toFixed(1)}m durationDiff=${match.durationDiffSeconds.toFixed(1)}s`,
        );
    });

    result.fuzzyMatches.slice(0, 20).forEach((match, index) => {
        console.log(
            `FUZZY_MATCH[${index + 1}]: ${summarizeActivity(match.cnActivity)} | ` +
            `global=${summarizeActivity(match.globalActivity)} | ` +
            `distanceDiff=${match.distanceDiffMeters.toFixed(1)}m durationDiff=${match.durationDiffSeconds.toFixed(1)}s`,
        );
    });
};

const backfillMissingActivities = async (clientCN: any, clientGlobal: any, activities: Activity[]) => {
    let uploaded = 0;
    let failed = 0;

    for (let index = activities.length - 1; index >= 0; index--) {
        const activity = activities[index];
        console.log(`BACKFILL[${activities.length - index}/${activities.length}]: ${summarizeActivity(activity)}`);
        const filePath = await downloadGarminActivity(activity.activityId, clientCN);
        const ok = await uploadGarminActivity(filePath, clientGlobal);
        if (ok) {
            uploaded++;
        } else {
            failed++;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log(`Backfill uploaded: ${uploaded}`);
    console.log(`Backfill failed: ${failed}`);

    if (failed > 0) {
        process.exitCode = 1;
    }
};

const main = async () => {
    const mode = getMode();
    const fetchLimit = getNumberEnv('GARMIN_AUDIT_LIMIT', DEFAULT_LIMIT);
    const backfillLimit = getNumberEnv('GARMIN_BACKFILL_LIMIT', 50);
    const startDate = parseLocalDate(getStringEnv('GARMIN_BACKFILL_START'));
    const endDate = parseLocalDate(getStringEnv('GARMIN_BACKFILL_END'), true);
    const oldestAllowedDate = getOldestAllowedDate(startDate);

    console.log(`Mode: ${mode}`);
    console.log(`Fetch limit: ${fetchLimit}`);
    console.log(`Backfill limit: ${backfillLimit}`);
    console.log(`Date window: ${startDate ? formatDay(startDate) : 'unbounded'}..${endDate ? formatDay(endDate) : 'unbounded'}`);
    console.log(`Outage hint start: ${getStringEnv('GARMIN_OUTAGE_START') ?? 'none'}`);

    const clientCN = await getGaminCNClient();
    const clientGlobal = await getGaminGlobalClient();

    const [cnActivities, globalActivities] = await Promise.all([
        fetchActivities(clientCN, fetchLimit, oldestAllowedDate),
        fetchActivities(clientGlobal, fetchLimit, oldestAllowedDate),
    ]);

    const result = findMissingActivities(cnActivities, globalActivities, startDate, endDate);
    printCompareResult(result, backfillLimit);

    if (mode === 'backfill') {
        const toBackfill = result.missingInGlobal.slice(0, backfillLimit);
        await backfillMissingActivities(clientCN, clientGlobal, toBackfill);
    }
};

main().catch((error) => {
    console.error(error?.message ?? error);
    process.exit(1);
});
