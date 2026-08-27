<?php

declare(strict_types=1);

use Symfony\Component\Clock\Clock;
use Symfony\Component\Clock\MockClock;

$autoloadPath = dirname(__DIR__, 3).'/server/vendor/autoload.php';
if (!is_file($autoloadPath)) {
    throw new RuntimeException(sprintf('Missing Composer autoloader at %s', $autoloadPath));
}
require_once $autoloadPath;

$instant = getenv('BACKGROUND_OPERATIONS_CLOCK_INSTANT');
$timezoneName = getenv('BACKGROUND_OPERATIONS_CLOCK_TIMEZONE');
if (!is_string($instant) || '' === $instant || 'Europe/Oslo' !== $timezoneName) {
    throw new RuntimeException('The background-operations clock requires an instant and Europe/Oslo timezone.');
}

$timezone = new DateTimeZone($timezoneName);
$now = DateTimeImmutable::createFromFormat('!Y-m-d H:i:s', $instant, $timezone);
if (!$now instanceof DateTimeImmutable || $now->format('Y-m-d H:i:s') !== $instant) {
    throw new RuntimeException(sprintf('Invalid background-operations clock instant: %s', $instant));
}
Clock::set(new MockClock($now));

final class BackgroundOperationsTimeUtil
{
    public static function dateTimeIsToday(DateTime $date): bool
    {
        return $date->format('Ymd') === Clock::get()->now()->format('Ymd');
    }

    public static function dateTimeIsInTheFuture(DateTime $date): bool
    {
        return $date > Clock::get()->now();
    }
}

if (class_exists(App\Support\Utils\TimeUtil::class, false)) {
    throw new RuntimeException('The background-operations clock must load before TimeUtil.');
}
class_alias(BackgroundOperationsTimeUtil::class, App\Support\Utils\TimeUtil::class);
