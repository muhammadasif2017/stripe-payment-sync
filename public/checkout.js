// The checkout page's script. A file rather than an inline <script>, so the Content-Security-Policy
// can allow scripts from this site only (script-src 'self').
const list = document.getElementById('courses');
const errorBox = document.getElementById('error');

function price(course) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: course.currency }).format(
    course.amount / 100,
  );
}

async function buy(course, button) {
  errorBox.textContent = '';
  button.disabled = true;
  const email = document.getElementById('email').value.trim();
  try {
    const response = await fetch('/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Only the course ID: the server decides the price.
      body: JSON.stringify(email ? { courseId: course.id, email } : { courseId: course.id }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error([].concat(body.message || 'Checkout failed').join(', '));
    window.location.href = body.checkoutUrl;
  } catch (error) {
    errorBox.textContent = error.message;
    button.disabled = false;
  }
}

fetch('/checkout/courses')
  .then((response) => response.json())
  .then((courses) => {
    list.replaceChildren(
      ...courses.map((course) => {
        const row = document.createElement('div');
        row.className = 'course';
        const label = document.createElement('span');
        // textContent, never innerHTML: course data is shown as text, not run as markup.
        label.textContent = `${course.name} (${price(course)})`;
        const button = document.createElement('button');
        button.textContent = 'Buy';
        button.addEventListener('click', () => buy(course, button));
        row.append(label, button);
        return row;
      }),
    );
  })
  .catch(() => {
    list.textContent = 'Could not load the courses. Is the API running?';
  });
