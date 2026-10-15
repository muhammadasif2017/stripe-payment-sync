import { findCourse, listCourses } from './catalog.js';

describe('course catalog', () => {
  it('finds a course by ID with its server-side price', () => {
    expect(findCourse('nestjs-fundamentals')).toEqual({
      id: 'nestjs-fundamentals',
      name: 'NestJS Fundamentals',
      amount: 4900,
      currency: 'usd',
    });
  });

  it.each([
    'unknown-course',
    '',
    '__proto__',
    'constructor',
    'NESTJS-FUNDAMENTALS',
  ])('returns undefined for %j', (id) => {
    expect(findCourse(id)).toBeUndefined();
  });

  it('lists only valid courses: unique IDs, positive integer amounts, lowercase 3-letter currency', () => {
    const courses = listCourses();

    expect(courses.length).toBeGreaterThan(0);
    expect(new Set(courses.map((c) => c.id)).size).toBe(courses.length);
    for (const course of courses) {
      expect(Number.isInteger(course.amount) && course.amount > 0).toBe(true);
      expect(course.currency).toMatch(/^[a-z]{3}$/);
    }
  });
});
