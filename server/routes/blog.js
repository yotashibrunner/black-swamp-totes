'use strict';

// Blog / SEO content pages. Each post is static content rendered through a
// shared template (server/views/blog-post.ejs). Add posts to POSTS keyed by
// slug; the sitemap (routes/public.js) reads POSTS to list them.

const express = require('express');
const config = require('../config');

const router = express.Router();

const POSTS = {
  'moving-bins-toledo-ohio': {
    slug: 'moving-bins-toledo-ohio',
    title: 'Moving Bins Delivered in Toledo, Ohio | Black Swamp Totes',
    metaDescription: 'Rent reusable moving bins delivered to your door in Toledo, Maumee, Perrysburg, Sylvania, Oregon, Northwood, and Bowling Green. Free delivery and pickup. Starting at $99/week.',
    h1: 'Reusable Moving Bins Delivered in Toledo, Ohio',
    updated: 'June 2026',
    content: `
      <p>Moving is stressful enough without hunting down cardboard boxes, buying tape, and figuring out what to do with it all when you're done. If you're planning a move in Toledo or Northwest Ohio, there's a better way.</p>
      <p>Black Swamp Totes delivers heavy-duty reusable plastic moving bins straight to your door — and picks them up from your new place when you're done. No cardboard. No tape. No waste.</p>

      <h2>How It Works</h2>
      <p>Booking is simple. Choose your package at <a href="/#packages">blackswamptotes.com</a>, pick your delivery date, and we'll drop off your bins the morning of. Stack your belongings, load the truck, and move into your new place. When you're settled, text us and we'll come pick the bins up — from your new address, not your old one. Free delivery and free pickup included with every rental.</p>

      <h2>Packages for Every Move</h2>
      <p>Whether you're moving out of a dorm at UT Toledo or out of a four-bedroom house in Sylvania, we have a package that fits:</p>
      <ul class="blog-list">
        <li><strong>Studio or Dorm</strong> — 15 bins and a dolly for $99/week. Perfect for single rooms, studio apartments, and college move-outs.</li>
        <li><strong>1 Bedroom</strong> — 25 bins and a dolly for $129/week. Built for one-bedroom apartments and condos across Toledo.</li>
        <li><strong>2 Bedroom</strong> — 40 bins and a dolly for $159/week. Handles two-bedroom apartments and houses comfortably.</li>
        <li><strong>3–4 Bedroom</strong> — 55 bins and two dollies for $199/week. Everything you need for a full house move.</li>
      </ul>
      <p>Need something custom? Order exactly what you need at $4.25 per bin per week, minimum 10 bins.</p>

      <h2>Why Reusable Bins Beat Cardboard</h2>
      <p>The average move in Toledo generates 30 to 60 cardboard boxes. Most end up in a landfill within days. Our bins are sanitized between every rental and built to last hundreds of moves. Stronger, cleaner, and better for Northwest Ohio. No assembly. No tape. No recycling runs. Just pack and go.</p>

      <h2>Serving Toledo and Northwest Ohio</h2>
      <p>We deliver to Toledo, Oregon, Northwood, Maumee, Perrysburg, Sylvania, and Bowling Green. Book online at <a href="/#packages">blackswamptotes.com</a> or call and text us at <a href="tel:+14199721669">(419) 972-1669</a>.</p>
    `,
  },
};

// GET /blog/:slug — render one post; unknown slugs fall through to the branded 404.
router.get('/:slug', (req, res, next) => {
  const post = POSTS[req.params.slug];
  if (!post) return next();
  const origin = config.siteUrl || config.baseUrl || '';
  res.render('blog-post', { post, canonical: `${origin}/blog/${post.slug}` });
});

module.exports = router;
module.exports.POSTS = POSTS;
