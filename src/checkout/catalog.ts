/** A course customers can buy. Prices live here, on the server, so a client can't choose its own. */
export interface Course {
  id: string;
  name: string;
  /** Smallest currency unit (cents). */
  amount: number;
  /** Lowercase ISO code, as Stripe expects it. */
  currency: string;
}

// Sample courses for test payments. A real shop would load these from a table or from Stripe Products.
const COURSES: readonly Course[] = Object.freeze([
  {
    id: 'nestjs-fundamentals',
    name: 'NestJS Fundamentals',
    amount: 4900,
    currency: 'usd',
  },
  {
    id: 'stripe-webhooks',
    name: 'Stripe Webhooks in Practice',
    amount: 7900,
    currency: 'usd',
  },
]);

// A Map, not a plain object: a lookup like `catalog['__proto__']` must not find anything.
const COURSES_BY_ID = new Map(COURSES.map((course) => [course.id, course]));

/** Returns every course on sale, in display order. */
export function listCourses(): readonly Course[] {
  return COURSES;
}

/**
 * Finds a course by its ID.
 * @param id Course ID from the request, e.g. `nestjs-fundamentals`.
 * @returns The course, or `undefined` if no course has this ID.
 */
export function findCourse(id: string): Course | undefined {
  return COURSES_BY_ID.get(id);
}
